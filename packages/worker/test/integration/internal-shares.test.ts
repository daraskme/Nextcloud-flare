import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { privateAppRoute } from "../../src/api/privateApp";
import { handleShareHttp } from "../../src/api/shares";
import { accessPrincipal, authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { ListCursorTokens } from "../../src/auth/listCursor";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { listInternalShares, readInternalShare } from "../../src/services/internalShareRead";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { listTrash } from "../../src/services/trashRead";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const origin = "https://app.invalid";
async function fixture() {
  const users = Array.from({ length: 3 }, () =>
    foundationFixture(crypto.randomUUID(), Date.now() - 1000),
  );
  await atomicBatch(
    env.DB,
    users.flatMap((f) => [
      ...f.statements,
      {
        sql: "UPDATE users SET email=? WHERE id=?",
        values: [`${f.ids.user}@example.invalid`, f.ids.user],
      },
    ]),
  );
  const [own, recipient, other] = users as [
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
  ];
  const session = (f: typeof own): AccessSession => ({
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  });
  const ring = await contentKeyRing("v1", {
    v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const csrfRing = await csrfKeyRing("v1", {
    v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const csrf = new CsrfTokens(csrfRing, csrfRing, origin);
  const owner = session(own),
    viewer = session(recipient);
  const token = await csrf.issue(
    env.DB,
    new Request(`${origin}/api/v1/csrf`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: owner.credential_id, epoch: 1 },
  );
  const input = {
    kind: "internal",
    rootNodeId: own.ids.folder,
    recipients: [`${recipient.ids.user}@example.invalid`],
    role: "read",
    expiresAt: null,
  };
  const tokens = new ListCursorTokens(ring);
  const app = { ...mutationEnv(), APP_ORIGIN: origin };
  const headers = {
    "Content-Type": "application/json",
    "X-CSRF-Token": token.token,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
  const http = (path: string, init: RequestInit = {}, who = owner) =>
    handleShareHttp(new Request(`${origin}/api/v1/${path}`, init), app, who, csrf, tokens);
  return { own, recipient, other, owner, viewer, session, input, tokens, app, headers, http };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function readAs(f: Fixture) {
  return authorizeNode(env.DB, accessPrincipal(f.viewer), {
    operation: "node.read",
    spaceId: f.own.ids.space,
    nodeId: f.own.ids.file,
  });
}
async function trashAncestor(f: Fixture) {
  const op = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,purge_after,epoch) VALUES(?,?,?,?,'trashed',1,9999999999999,1)",
      values: [op, f.own.ids.user, f.own.ids.space, f.own.ids.folder],
    },
    {
      sql: "UPDATE nodes SET deleted_at=1,deleted_op_id=? WHERE id=?",
      values: [op, f.own.ids.folder],
    },
  ]);
}

it("creates through CSRF HTTP, grants read/edit, preserves the mount on rename and rejects re-sharing", async () => {
  const f = await fixture();
  await expect(readAs(f)).rejects.toThrow("authorization_denied");
  expect(privateAppRoute(new Request(`${origin}/api/v1/shares`, { method: "POST" }))).toBe(true);
  expect(privateAppRoute(new Request(`${origin}/api/v1/shared-with-me`))).toBe(true);
  const created = await f.http("shares", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify(f.input),
  });
  expect(created.status).toBe(201);
  expect(created.headers.get("ETag")).toBe('"share-1"');
  expect(created.headers.get("Cache-Control")).toBe("private, no-store");
  const share = await created.json<{ id: string; version: number }>();
  expect(await readAs(f)).toMatchObject({ node: { id: f.own.ids.file } });
  const createRequest = {
    operation: "node.create" as const,
    spaceId: f.own.ids.space,
    parentId: f.own.ids.folder,
  };
  await expect(authorizeNode(env.DB, accessPrincipal(f.viewer), createRequest)).rejects.toThrow();
  const before = await readInternalShare(env.DB, f.owner, share.id);
  expect(before).toMatchObject({
    role: "read",
    recipients: [{ userId: f.recipient.ids.user }],
    mountName: expect.stringMatching(/^[a-f0-9]{16}-Folder$/),
  });
  const received = await f.http("shared-with-me", {}, f.viewer);
  expect(await received.json()).toMatchObject({
    items: [{ id: share.id, recipients: [], mountName: before.mountName }],
  });
  await expect(
    createInternalShare(f.app, f.viewer, {
      ...f.input,
      recipients: [`${f.other.ids.user}@example.invalid`],
    }),
  ).rejects.toThrow("share_unavailable");
  expect((await f.http(`shares/${share.id}`, {}, f.viewer)).status).toBe(404);
  const updated = await f.http(`shares/${share.id}`, {
    method: "PATCH",
    headers: { ...f.headers, "If-Match": '"share-1"' },
    body: JSON.stringify({ ...f.input, role: "edit" }),
  });
  expect(updated.status).toBe(200);
  expect(updated.headers.get("ETag")).toBe('"share-2"');
  expect(await authorizeNode(env.DB, accessPrincipal(f.viewer), createRequest)).toMatchObject({
    operation: "node.create",
  });
  await env.DB.prepare(
    "UPDATE nodes SET name='Renamed',name_ci='renamed',revision=revision+1 WHERE id=?",
  )
    .bind(f.own.ids.folder)
    .run();
  expect(await readInternalShare(env.DB, f.owner, share.id)).toMatchObject({
    mountName: before.mountName,
    name: "Renamed",
  });
  const stale = await f.http(`shares/${share.id}`, {
    method: "DELETE",
    headers: { ...f.headers, "If-Match": '"share-1"' },
  });
  expect(stale.status).toBe(412);
  const stopped = await f.http(`shares/${share.id}`, {
    method: "DELETE",
    headers: { ...f.headers, "If-Match": '"share-2"' },
  });
  expect(await stopped.json()).toEqual({ id: share.id, version: 3, disabled: true });
  await expect(readAs(f)).rejects.toThrow();
  expect(await (await f.http("shared-with-me", {}, f.viewer)).json()).toEqual({
    items: [],
    nextCursor: null,
  });
});

it("replaces recipients, revokes existing share/content sessions and tickets without resetting budgets", async () => {
  const f = await fixture(),
    share = await createInternalShare(f.app, f.owner, f.input);
  const prefix = crypto.randomUUID(),
    now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO share_sessions(id,share_id,share_version,user_id,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,?,1,?,?)",
      values: [prefix, share.id, f.recipient.ids.user, prefix, now, now + 60000],
    },
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,share_id,epoch,expires_at,state) VALUES(?,?,?,?,1,?,'active')",
      values: [prefix, f.own.ids.user, f.recipient.ids.user, share.id, now + 60000],
    },
    {
      sql: "INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch) VALUES(?,?,?,'hash','ref',0,?,1)",
      values: [prefix, f.own.ids.user, f.viewer.credential_id, now + 60000],
    },
    {
      sql: "INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at) VALUES(?,?,?,?,'content',1,?,?)",
      values: [prefix, f.viewer.credential_id, prefix, prefix, now, now + 60000],
    },
    {
      sql: "INSERT INTO content_sessions(id,user_id,issued_by_credential_id,target_set_id,budget_id,share_id,share_version,epoch,issued_at,expires_at,ticket_id) VALUES(?,?,?,?,?,?,1,1,?,?,?)",
      values: [
        prefix,
        f.recipient.ids.user,
        f.viewer.credential_id,
        prefix,
        prefix,
        share.id,
        now,
        now + 60000,
        prefix,
      ],
    },
  ]);
  const budget = await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(prefix).first();
  await updateInternalShare(f.app, f.owner, share.id, 1, {
    ...f.input,
    recipients: [`${f.other.ids.user}@example.invalid`],
    role: "edit",
  });
  await expect(readAs(f)).rejects.toThrow();
  expect(await readAs({ ...f, viewer: f.session(f.other) })).toMatchObject({
    operation: "node.read",
  });
  for (const table of ["share_sessions", "content_sessions"])
    expect(
      await env.DB.prepare(`SELECT revoked_at FROM ${table} WHERE id=?`)
        .bind(prefix)
        .first("revoked_at"),
    ).toEqual(expect.any(Number));
  expect(
    await env.DB.prepare("SELECT cancelled_at FROM tickets WHERE id=?")
      .bind(prefix)
      .first("cancelled_at"),
  ).toEqual(expect.any(Number));
  expect(await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(prefix).first()).toEqual(
    budget,
  );
  await updateInternalShare(f.app, f.owner, share.id, 2, {
    ...f.input,
    recipients: [`${f.other.ids.user}@example.invalid`],
    role: "read",
  });
  await expect(
    authorizeNode(env.DB, accessPrincipal(f.session(f.other)), {
      operation: "node.create",
      spaceId: f.own.ids.space,
      parentId: f.own.ids.folder,
    }),
  ).rejects.toThrow();
});

it.each(["self", "unknown", "disabled", "ambiguous"] as const)(
  "rejects %s recipient identities without a share",
  async (kind) => {
    const f = await fixture();
    let email = f.input.recipients[0]!;
    if (kind === "self") email = `${f.own.ids.user}@example.invalid`;
    if (kind === "unknown") email = "missing@example.invalid";
    if (kind === "disabled")
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
        .bind(f.recipient.ids.user)
        .run();
    if (kind === "ambiguous")
      await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
        .bind(email.toUpperCase(), f.other.ids.user)
        .run();
    await expect(
      createInternalShare(f.app, f.owner, { ...f.input, recipients: [email] }),
    ).rejects.toThrow("share_recipient_unavailable");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id=?")
        .bind(f.own.ids.user)
        .first("n"),
    ).toBe(0);
  },
);

it.each([
  "logout",
  "recipient-disabled",
  "recipient-ambiguous",
  "ancestor-trash",
  "maintenance",
  "epoch",
] as const)("rechecks %s in the commit batch after waiting", async (kind) => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO shares("),
    async () => {
      if (kind === "logout")
        await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
          .bind(f.owner.session_id)
          .run();
      if (kind === "recipient-disabled")
        await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
          .bind(f.recipient.ids.user)
          .run();
      if (kind === "recipient-ambiguous")
        await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
          .bind(f.input.recipients[0], f.other.ids.user)
          .run();
      if (kind === "ancestor-trash") await trashAncestor(f);
      if (kind === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
      if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    },
    false,
  );
  await expect(createInternalShare({ ...f.app, DB: db }, f.owner, f.input)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id=?")
      .bind(f.own.ids.user)
      .first("n"),
  ).toBe(0);
});

it.each(["create", "update", "disable"] as const)(
  "recovers committed %s acknowledgement loss without repeating the mutation",
  async (kind) => {
    const f = await fixture();
    const saved = kind === "create" ? null : await createInternalShare(f.app, f.owner, f.input);
    let attempts = 0;
    const db = injectBatch(
      (sql) => sql.includes("committed_at="),
      async () => {
        attempts++;
        throw new Error("lost_ack");
      },
      true,
    );
    const app = { ...f.app, DB: db };
    const result = saved
      ? await updateInternalShare(
          app,
          f.owner,
          saved.id,
          1,
          kind === "disable" ? null : { ...f.input, role: "edit" },
        )
      : await createInternalShare(app, f.owner, f.input);
    expect(result.version).toBe(kind === "create" ? 1 : 2);
    expect(attempts).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id=?")
        .bind(f.own.ids.user)
        .first("n"),
    ).toBe(1);
  },
);

it.each(["update", "disable"] as const)(
  "rejects a concurrent version change at %s commit",
  async (kind) => {
    const f = await fixture(),
      saved = await createInternalShare(f.app, f.owner, f.input);
    const db = injectBatch(
      (sql) => sql.includes("UPDATE shares SET version"),
      async () => {
        await updateInternalShare(f.app, f.owner, saved.id, 1, { ...f.input, role: "edit" });
      },
      false,
    );
    await expect(
      updateInternalShare(
        { ...f.app, DB: db },
        f.owner,
        saved.id,
        1,
        kind === "disable" ? null : f.input,
      ),
    ).rejects.toThrow();
    expect(await readInternalShare(env.DB, f.owner, saved.id)).toMatchObject({
      version: 2,
      role: "edit",
    });
  },
);

it("rolls back share version, recipients, actions and receipt on a later SQL failure", async () => {
  const f = await fixture(),
    saved = await createInternalShare(f.app, f.owner, f.input);
  const before = await readInternalShare(env.DB, f.owner, saved.id);
  const db = injectBatch(
    (sql) => sql.includes("UPDATE shares SET version"),
    async () => {
      await env.DB.exec(
        "CREATE TRIGGER test_share_failure BEFORE INSERT ON share_actions BEGIN SELECT RAISE(ABORT,'injected_share_failure'); END;",
      );
    },
    false,
  );
  try {
    await expect(
      updateInternalShare({ ...f.app, DB: db }, f.owner, saved.id, 1, { ...f.input, role: "edit" }),
    ).rejects.toThrow("injected_share_failure");
    expect(await readInternalShare(env.DB, f.owner, saved.id)).toEqual(before);
  } finally {
    await env.DB.exec("DROP TRIGGER IF EXISTS test_share_failure");
  }
});

it("keeps expired shares manageable by their owner while hiding expired, revoked and ancestor-trashed grants", async () => {
  const f = await fixture(),
    saved = await createInternalShare(f.app, f.owner, { ...f.input, rootNodeId: f.own.ids.file });
  await env.DB.prepare("UPDATE shares SET expires_at=1 WHERE id=?").bind(saved.id).run();
  expect((await listInternalShares(env.DB, f.owner, f.tokens)).items).toHaveLength(1);
  expect((await listInternalShares(env.DB, f.viewer, f.tokens, { received: true })).items).toEqual(
    [],
  );
  await updateInternalShare(f.app, f.owner, saved.id, 1, {
    ...f.input,
    rootNodeId: f.own.ids.file,
  });
  expect(
    (await listInternalShares(env.DB, f.viewer, f.tokens, { received: true })).items,
  ).toHaveLength(1);
  await trashAncestor(f);
  expect((await listInternalShares(env.DB, f.viewer, f.tokens, { received: true })).items).toEqual(
    [],
  );
  await expect(readInternalShare(env.DB, f.owner, saved.id)).rejects.toThrow("share_unavailable");
  await expect(readAs(f)).rejects.toThrow();
});

it("binds pagination to list purpose, root, identity and credential and rechecks grants on every page", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await createInternalShare(f.app, f.owner, f.input);
  const first = await listInternalShares(env.DB, f.viewer, f.tokens, { received: true, limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).toBeTruthy();
  const second = await listInternalShares(env.DB, f.viewer, f.tokens, {
    received: true,
    cursor: first.nextCursor!,
    limit: 2,
  });
  expect(second.items).toHaveLength(1);
  expect(new Set([...first.items, ...second.items].map((s) => s.id)).size).toBe(3);
  await expect(
    listInternalShares(env.DB, f.viewer, f.tokens, { cursor: first.nextCursor! }),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listInternalShares(env.DB, f.session(f.other), f.tokens, {
      received: true,
      cursor: first.nextCursor!,
    }),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listTrash(
      env.DB,
      accessPrincipal(f.viewer),
      f.tokens,
      f.recipient.ids.space,
      first.nextCursor!,
    ),
  ).rejects.toThrow("invalid_list_cursor");
  const owned = await listInternalShares(env.DB, f.owner, f.tokens, {
    rootNodeId: f.own.ids.folder,
    limit: 1,
  });
  await expect(
    listInternalShares(env.DB, f.owner, f.tokens, {
      rootNodeId: f.own.ids.file,
      cursor: owned.nextCursor!,
    }),
  ).rejects.toThrow("invalid_list_cursor");
  await env.DB.prepare("UPDATE share_grants SET disabled_at=1 WHERE share_id=?")
    .bind(second.items[0]!.id)
    .run();
  expect(
    (
      await listInternalShares(env.DB, f.viewer, f.tokens, {
        received: true,
        cursor: first.nextCursor!,
      })
    ).items,
  ).toEqual([]);
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
    .bind(f.viewer.session_id)
    .run();
  await expect(
    listInternalShares(env.DB, f.viewer, f.tokens, { received: true }),
  ).rejects.toThrow();
});

it("rejects invalid HTTP bodies, CSRF, queries and missing version preconditions", async () => {
  const f = await fixture(),
    saved = await createInternalShare(f.app, f.owner, f.input);
  const path = `shares/${saved.id}`;
  for (const body of [
    "null",
    "[]",
    "{}",
    "{",
    JSON.stringify({ ...f.input, secret: "unwanted" }),
    " ".repeat(8193),
  ]) {
    const response = await f.http(path, {
      method: "PATCH",
      headers: { ...f.headers, "If-Match": '"share-1"' },
      body,
    });
    expect(response.status).toBe(400);
  }
  expect((await f.http(path, { method: "DELETE", headers: f.headers })).status).toBe(428);
  expect(
    (
      await f.http(path, {
        method: "DELETE",
        headers: { ...f.headers, "If-Match": '"share-1"' },
        body: "{}",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.http("shares", {
        method: "POST",
        body: JSON.stringify(f.input),
        headers: { ...f.headers, "X-CSRF-Token": "" },
      })
    ).status,
  ).toBe(403);
  for (const query of [
    "shares?rootNodeId=x&rootNodeId=y",
    "shared-with-me?rootNodeId=x",
    "shares?cursor=",
    `${path}?x=1`,
  ])
    expect((await f.http(query)).status).toBe(400);
  expect((await readInternalShare(env.DB, f.owner, saved.id)).version).toBe(1);
});
