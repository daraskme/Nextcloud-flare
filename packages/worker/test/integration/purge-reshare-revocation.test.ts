import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { lookupOperation } from "../../src/jobs/operations";
import { dispatchTreeJob } from "../../src/jobs/treeJobStore";
import { processTreeJob } from "../../src/jobs/treeJobWorker";
import { purgeTrash } from "../../src/services/purgeTrash";
import { createInternalShare } from "../../src/services/shares";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

it.each(["sync", "async"] as const)(
  "keeps moved reshares revoked when their former ancestor is purged (%s)",
  async (mode) => {
    const now = Date.now() - 1_000;
    const [owner, alice, bob, carol] = Array.from({ length: 4 }, () =>
      foundationFixture(crypto.randomUUID(), now),
    );
    if (!owner || !alice || !bob || !carol) throw new Error("fixture_actor_missing");
    const aliceEmail = `purge-${alice.ids.user}@test.invalid`;
    const bobEmail = `purge-${bob.ids.user}@test.invalid`;
    const carolEmail = `purge-${carol.ids.user}@test.invalid`;
    const movedFolderId = `moved-${crypto.randomUUID()}`;
    await atomicBatch(env.DB, [
      ...owner.statements,
      ...alice.statements,
      ...bob.statements,
      ...carol.statements,
      { sql: "UPDATE users SET email=? WHERE id=?", values: [aliceEmail, alice.ids.user] },
      { sql: "UPDATE users SET email=? WHERE id=?", values: [bobEmail, bob.ids.user] },
      { sql: "UPDATE users SET email=? WHERE id=?", values: [carolEmail, carol.ids.user] },
      {
        sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,'Moved','moved','folder',?,?)`,
        values: [movedFolderId, owner.ids.space, owner.ids.user, owner.ids.folder, now, now],
      },
    ]);
    const [ownerSession, aliceSession, bobSession] = await Promise.all([
      readAccessSession(env.DB, owner.ids.credential, 1),
      readAccessSession(env.DB, alice.ids.credential, 1),
      readAccessSession(env.DB, bob.ids.credential, 1),
    ]);
    if (!ownerSession || !aliceSession || !bobSession) throw new Error("fixture_session_missing");

    const source = await createInternalShare(mutationEnv(), ownerSession, {
      rootNodeId: owner.ids.folder,
      spaceId: owner.ids.space,
      recipientEmail: aliceEmail,
      actions: ["read", "download"],
      ttlDays: 30,
      resharePolicy: {
        enabled: true,
        actions: ["read"],
        maxDepth: 3,
        maxFanout: 3,
        ttlDays: 20,
      },
    });
    const delegated = await createInternalShare(mutationEnv(), aliceSession, {
      rootNodeId: movedFolderId,
      spaceId: owner.ids.space,
      recipientEmail: bobEmail,
      actions: ["read"],
      ttlDays: 10,
      idempotencyKey: `delegated-${owner.ids.user}`,
      sourceShareId: source.id,
    });
    const descendant = await createInternalShare(mutationEnv(), bobSession, {
      rootNodeId: movedFolderId,
      spaceId: owner.ids.space,
      recipientEmail: carolEmail,
      actions: ["read"],
      ttlDays: 5,
      idempotencyKey: `descendant-${owner.ids.user}`,
      sourceShareId: delegated.id,
    });

    // A move invalidates delegated status, but keeps the enabled share and its
    // immutable ancestry pointing at the file's former parent.
    await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
      .bind(owner.ids.root, movedFolderId)
      .run();
    if (mode === "async")
      await env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<999)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      SELECT ?||n,?,?,?,?||n,?||n,'folder',?,? FROM seq`,
      )
        .bind(
          `bulk-${owner.ids.user}-`,
          owner.ids.space,
          owner.ids.user,
          owner.ids.folder,
          `Bulk-${owner.ids.user}-`,
          `bulk-${owner.ids.user}-`,
          now,
          now,
        )
        .run();
    for (const id of [delegated.id, descendant.id]) {
      expect(
        await env.DB.prepare("SELECT valid FROM share_delegation_status WHERE share_id=?")
          .bind(id)
          .first<number>("valid"),
      ).toBe(0);
      expect(
        await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
          .bind(id)
          .first<number | null>("disabled_at"),
      ).toBeNull();
    }

    const principal = {
      kind: "user" as const,
      user_id: owner.ids.user,
      credential_id: owner.ids.credential,
      epoch: 1,
    };
    const finish = async (operationId: string) => {
      const workerEnv = mutationEnv();
      const visible = await lookupOperation(env.DB, principal, operationId);
      const jobId = visible?.job?.id;
      if (!jobId) throw new Error("tree_job_missing");
      for (let index = 0; index < 20; index++) {
        await dispatchTreeJob(workerEnv, { async send() {} }, jobId, 1);
        await processTreeJob(workerEnv, jobId);
        const current = await lookupOperation(env.DB, principal, operationId);
        if (current?.state === "committed") return;
      }
      throw new Error("tree_job_not_committed");
    };
    const trashed = await trashNode(admitted(), {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: owner.ids.space,
      nodeId: owner.ids.folder,
      lockTokens: [],
    });
    expect(trashed.kind).toBe("terminal");
    if (mode === "async") {
      if (trashed.kind !== "terminal") throw new Error("trash_not_started");
      await finish(trashed.operation.id);
    }
    const trashOpId = await env.DB.prepare("SELECT op_id FROM trash_ops WHERE root_node_id=?")
      .bind(owner.ids.folder)
      .first<string>("op_id");
    if (!trashOpId) throw new Error("trash_op_missing");
    const purged = await purgeTrash(admitted(), {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: owner.ids.space,
      trashOpId,
    });
    if (mode === "async") {
      if (purged.kind !== "terminal") throw new Error("purge_not_started");
      await finish(purged.operation.id);
    } else expect(purged).toMatchObject({ kind: "terminal", operation: { state: "committed" } });

    for (const id of [delegated.id, descendant.id]) {
      expect(
        await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
          .bind(id)
          .first<number | null>("disabled_at"),
      ).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT COUNT(*) FROM current_internal_shares WHERE share_id=?")
          .bind(id)
          .first<number>("COUNT(*)"),
      ).toBe(0);
    }
    expect(
      await env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(movedFolderId).first("id"),
    ).toBe(movedFolderId);
  },
);
