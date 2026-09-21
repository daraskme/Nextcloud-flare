import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import {
  assertOperationClaim,
  claimOperation,
  digestJson,
  lookupOperation,
  operationIntent,
  operationRow,
} from "../../src/jobs/operations";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(kind: "user" | "link_share" = "user") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  let principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  if (kind === "link_share") {
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
        values: [f.ids.user, f.ids.user, f.ids.folder, Date.now()],
      },
      {
        sql: "INSERT INTO share_actions VALUES(?,'read'),(?,'create')",
        values: [f.ids.user, f.ids.user],
      },
      {
        sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
        values: [f.ids.user, f.ids.user, f.ids.user, Date.now(), Date.now() + 60000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
        values: [`ss:${f.ids.user}`, f.ids.user],
      },
    ]);
    principal = {
      kind,
      share_id: f.ids.user,
      share_version: 1,
      credential_id: `ss:${f.ids.user}`,
      epoch: 1,
    };
  }
  const key = crypto.randomUUID();
  const request = {
    operation: "node.create" as const,
    spaceId: f.ids.space,
    parentId: f.ids.folder,
  };
  const intent = await operationIntent(
    principal,
    key,
    f.ids.space,
    "node.create",
    { name: "New" },
    { parentId: f.ids.folder },
  );
  const proof = await authorizeNode(env.DB, principal, request);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  return { ...f, principal, key, request, intent, proof, permit };
}

async function commitFixture(f: Awaited<ReturnType<typeof fixture>>) {
  await claimOperation(env.DB, f.intent, f.permit, f.proof, 1);
  // Operation-lookup fixture only; namespace commits will go through fsMutation.
  await env.DB.prepare("UPDATE operations SET state='committed',result_json=? WHERE op_id=?")
    .bind(
      JSON.stringify({ status: 201, nodeId: f.ids.file, name: "never disclose this snapshot" }),
      f.intent.id,
    )
    .run();
}

it("canonicalizes bounded JSON intents and refuses cycles, excessive depth and unsupported values", async () => {
  expect(await digestJson({ z: 1, a: { b: 2, a: [3, 4] } })).toBe(
    await digestJson({ a: { a: [3, 4], b: 2 }, z: 1 }),
  );
  expect(await digestJson([1, 2])).not.toBe(await digestJson([2, 1]));
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  let deep: unknown = null;
  for (let i = 0; i < 34; i++) deep = [deep];
  for (const value of [
    cyclic,
    deep,
    "x".repeat(16384),
    Number.NaN,
    0.5,
    undefined,
    new Date(),
    Array(8193).fill(0),
  ])
    await expect(digestJson(value)).rejects.toThrow();
});

it("binds a key to its exact credential and full intent while allowing canonical retries", async () => {
  const f = await fixture();
  const first = await claimOperation(env.DB, f.intent, f.permit, f.proof, 1);
  expect(first.kind).toBe("claimed");
  expect(await claimOperation(env.DB, f.intent, f.permit, f.proof, 1)).toEqual(first);
  if (first.kind !== "claimed") throw new Error("missing_claim");
  await atomicBatch(env.DB, [assertOperationClaim(first.claim)]);
  const changed = await operationIntent(
    f.principal,
    f.key,
    f.ids.space,
    "node.create",
    { name: "Different" },
    { parentId: f.ids.folder },
  );
  expect(changed.id).toBe(f.intent.id);
  await expect(claimOperation(env.DB, changed, f.permit, f.proof, 1)).rejects.toThrow(
    "idempotency_conflict",
  );
  await expect(claimOperation(env.DB, f.intent, f.permit, f.proof, 2)).rejects.toThrow(
    "idempotency_conflict",
  );
  const otherCredential = await operationIntent(
    { ...f.principal, credential_id: "as:other" },
    f.key,
    f.ids.space,
    "node.create",
    { name: "New" },
    { parentId: f.ids.folder },
  );
  expect(otherCredential.id).not.toBe(f.intent.id);
  await expect(
    operationIntent(f.principal, "bad key", f.ids.space, "node.create", {}, {}),
  ).rejects.toThrow("invalid_idempotency_key");
});

it("allows one winner for concurrent conflicting payloads without overwriting the durable intent", async () => {
  const f = await fixture();
  const changed = await operationIntent(
    f.principal,
    f.key,
    f.ids.space,
    "node.create",
    { name: "Other" },
    { parentId: f.ids.folder },
  );
  const results = await Promise.allSettled(
    [f.intent, changed].map((intent) => claimOperation(env.DB, intent, f.permit, f.proof, 1)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE space_id=?")
      .bind(f.ids.space)
      .first("n"),
  ).toBe(1);
});

it("reconciles a claim response lost after commit and rechecks current authorization", async () => {
  const f = await fixture();
  let calls = 0;
  const lossy = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === 1) throw new Error("response_lost");
      return result;
    },
  } as unknown as D1Database;
  expect((await claimOperation(lossy, f.intent, f.permit, f.proof, 1)).kind).toBe("claimed");
  expect(calls).toBe(2);
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  await expect(claimOperation(env.DB, f.intent, f.permit, f.proof, 1)).rejects.toThrow();
  expect((await operationRow(env.DB, f.intent.id))?.state).toBe("claimed");
});

it.each(["parent", "actor", "kind", "epoch", "credential", "proof"])(
  "rejects a mismatched %s before creating an operation",
  async (field) => {
    const f = await fixture();
    let intent = f.intent;
    if (field === "parent")
      intent = { ...intent, operands: JSON.stringify({ parentId: f.ids.root }) };
    if (field === "actor") intent = { ...intent, principalId: "other" };
    if (field === "kind")
      intent = {
        ...intent,
        principal: {
          kind: "app_password",
          user_id: f.ids.user,
          credential_id: f.ids.credential,
          epoch: 1,
        },
      };
    if (field === "epoch") intent = { ...intent, principal: { ...intent.principal, epoch: 2 } };
    if (field === "credential")
      intent = { ...intent, principal: { ...intent.principal, credential_id: "as:other" } };
    await expect(
      claimOperation(env.DB, intent, f.permit, field === "proof" ? { ...f.proof } : f.proof, 1),
    ).rejects.toThrow();
    expect(await operationRow(env.DB, intent.id)).toBeNull();
  },
);

it("cannot resume a claim with changed permit identity or share version", async () => {
  const f = await fixture("link_share");
  const result = await claimOperation(env.DB, f.intent, f.permit, f.proof, 1);
  if (result.kind !== "claimed") throw new Error("missing_claim");
  await expect(
    claimOperation(env.DB, f.intent, { ...f.permit, permit_id: "different" }, f.proof, 1),
  ).rejects.toThrow();
  await expect(
    claimOperation(
      env.DB,
      f.intent,
      { ...f.permit, expires_at: f.permit.expires_at + 1 },
      f.proof,
      1,
    ),
  ).rejects.toThrow();
  if (f.principal.kind !== "link_share") throw new Error("missing_share");
  const changed = { ...f.intent, principal: { ...f.principal, share_version: 2 } };
  await expect(claimOperation(env.DB, changed, f.permit, f.proof, 1)).rejects.toThrow(
    "invalid_operation_claim",
  );
  await expect(
    atomicBatch(env.DB, [assertOperationClaim({ ...result.claim, intent: changed })]),
  ).rejects.toThrow();
});

it("protects operation identity and terminal state in the database", async () => {
  const f = await fixture();
  await commitFixture(f);
  for (const set of [
    "credential_version=2",
    "request_digest='changed'",
    "operands_json='{}'",
    "expected_steps=2",
    "updated_at=0",
    "state='claimed'",
  ])
    await expect(
      env.DB.prepare(`UPDATE operations SET ${set} WHERE op_id=?`).bind(f.intent.id).run(),
    ).rejects.toThrow();
  expect((await claimOperation(env.DB, f.intent, f.permit, f.proof, 1)).kind).toBe("terminal");
});

it.each(["user", "link_share"] as const)(
  "looks up a %s operation only through its initiating credential and current operands",
  async (kind) => {
    const f = await fixture(kind);
    await commitFixture(f);
    expect(await lookupOperation(env.DB, f.principal, f.intent.id)).toEqual({
      id: f.intent.id,
      state: "committed",
      errorCode: null,
      result: { status: 201, nodeId: f.ids.file, revision: 1 },
    });
    expect(
      await lookupOperation(env.DB, { ...f.principal, credential_id: "as:other" }, f.intent.id),
    ).toBeNull();
    expect(await lookupOperation(env.DB, { ...f.principal, epoch: 2 }, f.intent.id)).toBeNull();
    if (f.principal.kind === "link_share") {
      expect(
        await lookupOperation(env.DB, { ...f.principal, share_version: 2 }, f.intent.id),
      ).toBeNull();
      await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='create'")
        .bind(f.ids.user)
        .run();
    } else {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    }
    expect(await lookupOperation(env.DB, f.principal, f.intent.id)).toBeNull();
    await expect(claimOperation(env.DB, f.intent, f.permit, f.proof, 1)).rejects.toThrow();
  },
);

it("returns only status after the result node is purged, then hides the operation when its original parent is gone", async () => {
  const f = await fixture();
  await commitFixture(f);
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.ids.file).run();
  expect((await lookupOperation(env.DB, f.principal, f.intent.id))?.result).toEqual({
    status: 201,
  });
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.ids.folder).run();
  expect(await lookupOperation(env.DB, f.principal, f.intent.id)).toBeNull();
});

it("exposes stable failure codes without returning stored diagnostic text", async () => {
  const f = await fixture();
  await claimOperation(env.DB, f.intent, f.permit, f.proof, 1);
  await env.DB.prepare(
    "UPDATE operations SET state='failed',error_code='internal/path/secret' WHERE op_id=?",
  )
    .bind(f.intent.id)
    .run();
  expect(await lookupOperation(env.DB, f.principal, f.intent.id)).toEqual({
    id: f.intent.id,
    state: "failed",
    errorCode: "operation_failed",
    result: null,
  });
});
