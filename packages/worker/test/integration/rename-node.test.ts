import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { claimOperation, operationIntent } from "../../src/jobs/operations";
import { commitMutationStatements } from "../../src/services/fsMutation";
import {
  RENAME_NODE_STEPS,
  renameMutationPlan,
  renameMutationStatements,
  renameNode,
} from "../../src/services/renameNode";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

async function seeded() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const old = searchName("元の名前");
  await env.DB.prepare("UPDATE nodes SET name='元の名前',name_ci='元の名前' WHERE id=?")
    .bind(f.ids.folder)
    .run();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.folder, f.ids.space, old.textNorm, old.tokens, old.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.folder],
    },
  ]);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  return { f, principal };
}

async function planned() {
  const { f, principal } = await seeded();
  const name = "新しい名前";
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.rename",
    nodeId: f.ids.folder,
    spaceId: f.ids.space,
  });
  if (authorized.operation !== "node.rename") throw new Error("missing_rename_proof");
  const intent = await operationIntent(
    principal,
    crypto.randomUUID(),
    f.ids.space,
    "node.rename",
    { nodeId: f.ids.folder, name },
    { nodeId: f.ids.folder, parentId: authorized.parentId },
  );
  const permit = await grantPermit(env.DB, `p:${intent.id}`, f.ids.space, 1);
  const claimed = await claimOperation(env.DB, intent, permit, authorized, RENAME_NODE_STEPS);
  if (claimed.kind !== "claimed") throw new Error("missing_claim");
  const parentRevision = await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(authorized.parentId)
    .first<number>("revision");
  if (parentRevision === null) throw new Error("missing_parent");
  return { f, plan: renameMutationPlan(claimed.claim, authorized, parentRevision, name, []) };
}

function admitted(): Pick<Env, "DB" | "LOCKS"> {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }) }),
    } as unknown as Env["CONTROL"],
  };
  return {
    DB: env.DB,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const stub = env.LOCKS.get(id);
        const invoke = async <T>(callback: (instance: LockDO) => Promise<T>): Promise<T> => {
          const result = await runInDurableObject(stub, async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_error",
              };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireRename: (request: Parameters<LockDO["acquireRename"]>[0]) =>
            invoke((lock) => lock.acquireRename(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

it("renames through LockDO and replays the same idempotency key", async () => {
  const { f, principal } = await seeded();
  const request = {
    principal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    name: "サービス経由の名前",
    lockTokens: [],
  };
  const runtime = admitted();
  expect(await renameNode(runtime, request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(await renameNode(runtime, request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: request.name, revision: 2 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM outbox WHERE payload_ref=? AND kind='node.renamed'")
      .bind(f.ids.folder)
      .first("COUNT(*)"),
  ).toBe(1);
  await expect(renameNode(runtime, { ...request, name: "別名" })).rejects.toThrow(
    /idempotency_conflict/,
  );
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
  await expect(renameNode(runtime, request)).rejects.toThrow(/authorization_denied/);
});

it("atomically renames a node and replaces its search terms, with one terminal result", async () => {
  const { f, plan } = await planned();
  const statements = renameMutationStatements(plan);
  expect(await commitMutationStatements(env.DB, plan.claim, statements)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: "新しい名前", revision: 2 });
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(plan.authorized.parentId)
      .first("revision"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first("tree_generation"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH ?")
      .bind('tokens:"元の"')
      .first("COUNT(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH ?")
      .bind('tokens:"新し"')
      .first("COUNT(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT kind FROM outbox WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("kind"),
  ).toBe("node.renamed");
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(plan.claim.intent.id)
    .run();
  expect(await consumeOutbox(env.DB, `${plan.claim.intent.id}_event`)).toBe("completed");
  expect(await commitMutationStatements(env.DB, plan.claim, statements)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM activity WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("COUNT(*)"),
  ).toBe(1);
});

it("rolls back every effect when the new name conflicts with a sibling", async () => {
  const { f, plan } = await planned();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
  )
    .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.root, "新しい名前", "新しい名前")
    .run();
  expect(
    await commitMutationStatements(env.DB, plan.claim, renameMutationStatements(plan)),
  ).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: "元の名前", revision: 1 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM outbox WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("COUNT(*)"),
  ).toBe(0);
});
