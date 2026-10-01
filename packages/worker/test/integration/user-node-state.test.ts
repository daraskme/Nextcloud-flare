import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleShareHttp } from "../../src/api/shares";
import { handleUserNodeStateHttp } from "../../src/api/userNodeState";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { readAccessSession } from "../../src/auth/sessions";
import { UserNodeCursorTokens } from "../../src/auth/userNodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { listNodeChildren } from "../../src/services/nodeRead";
import { listUserNodes, recordNodeOpen, setNodeStar } from "../../src/services/userNodeState";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () =>
  env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,backup_frozen=0").run(),
);

async function fixture() {
  const current = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...current.statements, ...other.statements]);
  const principal = {
    kind: "user" as const,
    user_id: current.ids.user,
    credential_id: current.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("state", {
    state: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  return {
    current,
    other,
    principal,
    cursors: new UserNodeCursorTokens(ring),
    serviceEnv: mutationEnv(),
  };
}

it("keeps star and recent state private, idempotent and throttled", async () => {
  const t = await fixture();
  await env.DB.prepare(
    "INSERT INTO user_node_state(user_id,node_id,starred,last_opened_at) VALUES(?,?,1,?)",
  )
    .bind(t.other.ids.user, t.current.ids.file, 1)
    .run();

  await setNodeStar(t.serviceEnv, t.principal, t.current.ids.file, true);
  await setNodeStar(t.serviceEnv, t.principal, t.current.ids.file, true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_node_state WHERE user_id=? AND node_id=? AND starred=1",
    )
      .bind(t.principal.user_id, t.current.ids.file)
      .first("n"),
  ).toBe(1);

  expect(await recordNodeOpen(t.serviceEnv, t.principal, t.current.ids.file, 100_000)).toEqual({
    recorded: true,
  });
  expect(await recordNodeOpen(t.serviceEnv, t.principal, t.current.ids.file, 101_000)).toEqual({
    recorded: false,
  });
  expect(
    await env.DB.prepare("SELECT last_opened_at FROM user_node_state WHERE user_id=? AND node_id=?")
      .bind(t.principal.user_id, t.current.ids.file)
      .first("last_opened_at"),
  ).toBe(100_000);
  await recordNodeOpen(t.serviceEnv, t.principal, t.current.ids.file, 160_000);

  const starred = await listUserNodes(env.DB, t.principal, "starred", t.cursors);
  expect(starred.items).toEqual([
    expect.objectContaining({
      id: t.current.ids.file,
      ownerId: t.current.ids.user,
      starred: true,
      lastOpenedAt: 160_000,
    }),
  ]);
  const recent = await listUserNodes(env.DB, t.principal, "recent", t.cursors);
  expect(recent.items).toEqual([
    expect.objectContaining({ id: t.current.ids.file, lastOpenedAt: 160_000 }),
  ]);

  await setNodeStar(t.serviceEnv, t.principal, t.current.ids.file, false);
  await setNodeStar(t.serviceEnv, t.principal, t.current.ids.file, false);
  expect(
    await env.DB.prepare(
      "SELECT starred,last_opened_at FROM user_node_state WHERE user_id=? AND node_id=?",
    )
      .bind(t.principal.user_id, t.current.ids.file)
      .first(),
  ).toEqual({ starred: 0, last_opened_at: 160_000 });
  expect((await listUserNodes(env.DB, t.principal, "starred", t.cursors)).items).toEqual([]);
  const trashOp = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch)
        VALUES(?,?,?,?,'trashed',?,1)`,
      values: [trashOp, t.current.ids.user, t.current.ids.space, t.current.ids.file, 170_000],
    },
    {
      sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
      values: [170_000, trashOp, t.current.ids.file],
    },
  ]);
  expect((await listUserNodes(env.DB, t.principal, "recent", t.cursors)).items).toEqual([]);
});

it("bounds pages and rejects cursors after principal changes", async () => {
  const t = await fixture();
  const nodes = Array.from({ length: 11 }, (_, index) => ({
    id: `${t.current.ids.user}-star-${String(index).padStart(2, "0")}`,
    name: `Star ${index}`,
  }));
  await atomicBatch(
    env.DB,
    nodes.map(({ id, name }) => ({
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',0,0)`,
      values: [
        id,
        t.current.ids.space,
        t.current.ids.user,
        t.current.ids.folder,
        name,
        name.toLowerCase(),
      ],
    })),
  );
  await atomicBatch(
    env.DB,
    nodes.map(({ id }) => ({
      sql: "INSERT INTO user_node_state(user_id,node_id,starred) VALUES(?,?,1)",
      values: [t.current.ids.user, id],
    })),
  );
  const first = await listUserNodes(env.DB, t.principal, "starred", t.cursors);
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).toBeTruthy();
  const next = await listUserNodes(
    env.DB,
    t.principal,
    "starred",
    t.cursors,
    first.nextCursor ?? "",
  );
  expect(next.items).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  await expect(
    listUserNodes(
      env.DB,
      { ...t.principal, credential_id: t.other.ids.credential },
      "starred",
      t.cursors,
      first.nextCursor ?? "",
    ),
  ).rejects.toThrow("invalid_user_node_cursor");
});

it("enforces private route cursor, body and CSRF boundaries", async () => {
  const t = await fixture();
  await setNodeStar(t.serviceEnv, t.principal, t.current.ids.file, true);
  const csrf = { verify: vi.fn(async () => undefined) };
  const listed = await handleUserNodeStateHttp(
    new Request("https://app.invalid/api/v1/starred"),
    { ...t.serviceEnv, APP_ORIGIN: "https://app.invalid" },
    t.principal,
    csrf,
    t.cursors,
  );
  expect(listed.status).toBe(200);
  expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await listed.json()) as object).toEqual(
    expect.objectContaining({
      kind: "starred",
      items: [expect.objectContaining({ starred: true })],
    }),
  );

  const stale = await handleUserNodeStateHttp(
    new Request("https://app.invalid/api/v1/starred?cursor=invalid"),
    { ...t.serviceEnv, APP_ORIGIN: "https://app.invalid" },
    t.principal,
    csrf,
    t.cursors,
  );
  expect(stale.status).toBe(409);

  const invalid = await handleUserNodeStateHttp(
    new Request(`https://app.invalid/api/v1/nodes/${t.current.ids.file}/star`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: false, extra: true }),
    }),
    { ...t.serviceEnv, APP_ORIGIN: "https://app.invalid" },
    t.principal,
    csrf,
  );
  expect(invalid.status).toBe(400);
  expect(csrf.verify).toHaveBeenCalledOnce();

  const forbidden = await handleUserNodeStateHttp(
    new Request(`https://app.invalid/api/v1/nodes/${t.current.ids.file}/recent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    { ...t.serviceEnv, APP_ORIGIN: "https://app.invalid" },
    t.principal,
    { verify: vi.fn(async () => Promise.reject(new Error("forbidden"))) },
  );
  expect(forbidden.status).toBe(403);
});

it("isolates shared-node state and removes it from reads immediately after revoke", async () => {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    {
      sql: "UPDATE users SET email='owner-state@example.invalid' WHERE id=?",
      values: [owner.ids.user],
    },
    {
      sql: "UPDATE users SET email='recipient-state@example.invalid' WHERE id=?",
      values: [recipient.ids.user],
    },
  ]);
  const ownerPrincipal = await readAccessSession(env.DB, owner.ids.credential, 1);
  const recipientPrincipal = await readAccessSession(env.DB, recipient.ids.credential, 1);
  if (!ownerPrincipal || !recipientPrincipal) throw new Error("fixture_session_missing");
  const ownerStatePrincipal = {
    kind: "user" as const,
    user_id: ownerPrincipal.user_id,
    credential_id: ownerPrincipal.credential_id,
    epoch: ownerPrincipal.epoch,
  };
  const recipientStatePrincipal = {
    kind: "user" as const,
    user_id: recipientPrincipal.user_id,
    credential_id: recipientPrincipal.credential_id,
    epoch: recipientPrincipal.epoch,
  };
  const serviceEnv = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
  };
  const csrf = { verify: vi.fn(async () => undefined) };
  const created = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "internal",
        rootNodeId: owner.ids.folder,
        spaceId: owner.ids.space,
        recipientEmail: "recipient-state@example.invalid",
        actions: ["read"],
      }),
    }),
    serviceEnv,
    ownerPrincipal,
    csrf,
  );
  expect(created.status).toBe(201);
  const share = (await created.json()) as { id: string };
  const ring = await contentKeyRing("shared-state", {
    "shared-state": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cursors = new UserNodeCursorTokens(ring);

  await setNodeStar(serviceEnv, recipientStatePrincipal, owner.ids.file, true);
  const nodeCursors = new NodeCursorTokens(ring);
  expect(
    (await listNodeChildren(env.DB, recipientStatePrincipal, owner.ids.folder, nodeCursors))
      .children,
  ).toEqual([expect.objectContaining({ id: owner.ids.file, starred: true })]);
  expect(
    (await listNodeChildren(env.DB, ownerStatePrincipal, owner.ids.folder, nodeCursors)).children,
  ).toEqual([expect.objectContaining({ id: owner.ids.file, starred: false })]);
  expect((await listUserNodes(env.DB, recipientStatePrincipal, "starred", cursors)).items).toEqual([
    expect.objectContaining({ id: owner.ids.file, ownerId: owner.ids.user }),
  ]);
  expect((await listUserNodes(env.DB, ownerStatePrincipal, "starred", cursors)).items).toEqual([]);

  const revoked = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${share.id}`, { method: "DELETE" }),
    serviceEnv,
    ownerPrincipal,
    csrf,
  );
  expect(revoked.status).toBe(204);
  expect((await listUserNodes(env.DB, recipientStatePrincipal, "starred", cursors)).items).toEqual(
    [],
  );
});
