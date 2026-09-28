import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleShareHttp } from "../../src/api/shares";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import { readAccessSession } from "../../src/auth/sessions";
import {
  matchesSharePassword,
  type SharePasswordRecord,
  shareSecretDigest,
} from "../../src/auth/shareSecrets";
import { atomicBatch } from "../../src/db/primary";
import { listInternalShares } from "../../src/services/internalShareRead";
import { createInternalShare } from "../../src/services/internalShares";
import { listLinkShares, readLinkShare } from "../../src/services/linkShareRead";
import { createLinkShare, updateLinkShare } from "../../src/services/linkShares";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const own = foundationFixture(crypto.randomUUID(), Date.now() - 1000),
    other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...own.statements, ...other.statements]);
  const owner = (await readAccessSession(env.DB, own.ids.credential, 1))!,
    outsider = (await readAccessSession(env.DB, other.ids.credential, 1))!,
    ring = {
      ...(await contentKeyRing("v1", {
        v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      })),
      derive: localKdf,
    },
    tokens = new ListCursorTokens(ring),
    app = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" },
    input = { kind: "link", rootNodeId: own.ids.folder, role: "read", expiresAt: null };
  const csrf = { verify: vi.fn(async () => {}) };
  const http = (path: string, init: RequestInit = {}, session = owner) =>
    handleShareHttp(
      new Request(app.APP_ORIGIN + "/api/v1/" + path, init),
      app,
      session,
      csrf,
      tokens,
      ring,
    );
  const create = (password?: string) =>
    createLinkShare(
      app,
      owner,
      { ...input, ...(password === undefined ? {} : { password }) },
      ring,
    );
  const passwordRow = (id: string) =>
    env.DB.prepare(
      "SELECT password_digest AS passwordDigest,salt,kdf,kdf_params AS kdfParams,kid FROM shares WHERE id=?",
    )
      .bind(id)
      .first<SharePasswordRecord>();
  return { own, other, owner, outsider, ring, tokens, app, input, csrf, http, create, passwordRow };
}
it.each([undefined, "p🔑ass"])(
  "creates and lists an owned link without exposing its stored secrets: %s",
  async (password) => {
    const f = await fixture(),
      saved = await f.create(password);
    expect(saved.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
        .bind(saved.id)
        .first("secret_digest"),
    ).toBe(await shareSecretDigest(saved.id, saved.secret));
    const share = await readLinkShare(env.DB, f.owner, saved.id);
    expect(share).toEqual({
      id: saved.id,
      kind: "link",
      rootNodeId: f.own.ids.folder,
      spaceId: f.own.ids.space,
      ownerId: f.own.ids.user,
      name: "Folder",
      nodeKind: "folder",
      version: 1,
      role: "read",
      createdAt: expect.any(Number),
      expiresAt: null,
      hasPassword: password !== undefined,
    });
    expect(await listLinkShares(env.DB, f.owner, f.tokens)).toEqual({
      items: [share],
      nextCursor: null,
    });
    expect((await listInternalShares(env.DB, f.owner, f.tokens)).items).toEqual([]);
    expect(JSON.stringify(share)).not.toContain(saved.secret);
    if (password)
      expect(
        await matchesSharePassword(saved.id, password, (await f.passwordRow(saved.id))!, f.ring),
      ).toBe(true);
  },
);
it("preserves omitted password, clears it explicitly and rotates the fragment independently", async () => {
  const f = await fixture(),
    saved = await f.create("password"),
    original = await f.passwordRow(saved.id);
  expect(
    await updateLinkShare(f.app, f.owner, saved.id, 1, { ...f.input, role: "edit" }, f.ring),
  ).toEqual({ id: saved.id, version: 2, disabled: false });
  expect(await f.passwordRow(saved.id)).toEqual(original);
  const rotated = await updateLinkShare(
    f.app,
    f.owner,
    saved.id,
    2,
    { ...f.input, rotateSecret: true },
    f.ring,
  );
  expect(rotated.secret).not.toBe(saved.secret);
  expect(await f.passwordRow(saved.id)).toEqual(original);
  expect(
    await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
      .bind(saved.id)
      .first("secret_digest"),
  ).toBe(await shareSecretDigest(saved.id, rotated.secret!));
  await updateLinkShare(f.app, f.owner, saved.id, 3, { ...f.input, password: null }, f.ring);
  expect(await f.passwordRow(saved.id)).toEqual({
    passwordDigest: null,
    salt: null,
    kdf: null,
    kdfParams: null,
    kid: null,
  });
  await updateLinkShare(f.app, f.owner, saved.id, 4, null);
  await expect(readLinkShare(env.DB, f.owner, saved.id)).rejects.toThrow("share_unavailable");
});
it.each(["update", "disable"])(
  "invalidates share sessions, content sessions and tickets on %s",
  async (mode) => {
    const f = await fixture(),
      saved = await f.create(),
      id = crypto.randomUUID(),
      now = Date.now();
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
        values: [id, saved.id, id, now, now + 60000],
      },
      {
        sql: "INSERT INTO budgets(id,owner_id,share_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
        values: [id, f.own.ids.user, saved.id, now + 60000],
      },
      {
        sql: "INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch) VALUES(?,?,?,'hash','ref',0,?,1)",
        values: [id, f.own.ids.user, f.owner.credential_id, now + 60000],
      },
      {
        sql: "INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at) VALUES(?,?,?,?,'content',1,?,?)",
        values: [id, f.owner.credential_id, id, id, now, now + 60000],
      },
      {
        sql: "INSERT INTO content_sessions(id,user_id,issued_by_credential_id,target_set_id,budget_id,share_id,share_version,epoch,issued_at,expires_at,ticket_id) VALUES(?,?,?,?,?,?,1,1,?,?,?)",
        values: [id, f.own.ids.user, f.owner.credential_id, id, id, saved.id, now, now + 60000, id],
      },
    ]);
    const budget = await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(id).first();
    await updateLinkShare(
      f.app,
      f.owner,
      saved.id,
      1,
      mode === "update" ? { ...f.input, role: "edit" } : null,
    );
    for (const table of ["share_sessions", "content_sessions"])
      expect(
        await env.DB.prepare(`SELECT revoked_at FROM ${table} WHERE id=?`)
          .bind(id)
          .first("revoked_at"),
      ).toEqual(expect.any(Number));
    expect(
      await env.DB.prepare("SELECT cancelled_at FROM tickets WHERE id=?")
        .bind(id)
        .first("cancelled_at"),
    ).toEqual(expect.any(Number));
    expect(await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(id).first()).toEqual(
      budget,
    );
  },
);
it("never gives another administrator or an internal recipient ownership of the link", async () => {
  const f = await fixture(),
    saved = await f.create();
  await expect(readLinkShare(env.DB, f.outsider, saved.id)).rejects.toThrow("share_unavailable");
  await expect(updateLinkShare(f.app, f.outsider, saved.id, 1, null)).rejects.toThrow(
    "share_unavailable",
  );
  await expect(createLinkShare(f.app, f.outsider, f.input)).rejects.toThrow("share_unavailable");
  expect((await listLinkShares(env.DB, f.outsider, f.tokens)).items).toEqual([]);
  await env.DB.prepare("UPDATE users SET email='recipient@example.invalid' WHERE id=?")
    .bind(f.other.ids.user)
    .run();
  await createInternalShare(f.app, f.owner, {
    kind: "internal",
    rootNodeId: f.own.ids.folder,
    role: "edit",
    recipients: ["recipient@example.invalid"],
  });
  await expect(createLinkShare(f.app, f.outsider, f.input)).rejects.toThrow("share_unavailable");
});
it("uses a version CAS for concurrent changes and keeps the original root fixed", async () => {
  const f = await fixture(),
    saved = await f.create();
  await expect(
    updateLinkShare(f.app, f.owner, saved.id, 1, { ...f.input, rootNodeId: f.own.ids.root }),
  ).rejects.toThrow("invalid_share_request");
  const result = await Promise.allSettled([
    updateLinkShare(f.app, f.owner, saved.id, 1, { ...f.input, role: "edit" }),
    updateLinkShare(f.app, f.owner, saved.id, 1, null),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await env.DB.prepare("SELECT version FROM shares WHERE id=?").bind(saved.id).first("version"),
  ).toBe(2);
});
it.each(["logout", "maintenance", "epoch", "owner", "expiry"])(
  "rolls back link creation when %s changes before commit",
  async (change) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO shares("),
      async () => {
        if (change === "logout")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(f.own.ids.session)
            .run();
        if (change === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(f.own.ids.user)
            .run();
        if (change === "expiry")
          await env.DB.prepare("UPDATE sessions SET expires_at=issued_at+1 WHERE id=?")
            .bind(f.own.ids.session)
            .run();
      },
      false,
    );
    await expect(createLinkShare({ ...f.app, DB: db }, f.owner, f.input)).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM shares WHERE owner_id=?")
        .bind(f.own.ids.user)
        .first("n"),
    ).toBe(0);
  },
);
it("does not persist a link when authority is revoked during password derivation", async () => {
  const f = await fixture(),
    ring = {
      ...f.ring,
      derive: async (...args: Parameters<typeof localKdf>) => {
        const result = await localKdf(...args);
        await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
          .bind(f.own.ids.session)
          .run();
        return result;
      },
    };
  await expect(
    createLinkShare(f.app, f.owner, { ...f.input, password: "password" }, ring),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM shares WHERE owner_id=?")
      .bind(f.own.ids.user)
      .first("n"),
  ).toBe(0);
});
it.each(["ack", "rollback", "reads"] as const)(
  "recovers %s mutation outcome without returning an unsaved secret",
  async (mode) => {
    const f = await fixture(),
      fault = systemMutationFault("share.create:", mode);
    const run = createLinkShare({ ...f.app, DB: fault.db }, f.owner, f.input);
    if (mode === "rollback" || mode === "reads") {
      await expect(run).rejects.toThrow();
      const visible = (await listLinkShares(env.DB, f.owner, f.tokens)).items;
      expect(visible).toHaveLength(mode === "rollback" ? 0 : 1);
      if (mode === "reads") {
        // The first secret was never confirmed to this caller. Rotate the discovered link;
        // do not automatically repeat POST and create a second share.
        const recovered = await updateLinkShare(f.app, f.owner, visible[0]!.id, 1, {
          ...f.input,
          rotateSecret: true,
        });
        expect(
          await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
            .bind(recovered.id)
            .first("secret_digest"),
        ).toBe(await shareSecretDigest(recovered.id, recovered.secret!));
        expect((await listLinkShares(env.DB, f.owner, f.tokens)).items).toHaveLength(1);
      }
    } else {
      const saved = await run;
      expect(
        await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
          .bind(saved.id)
          .first("secret_digest"),
      ).toBe(await shareSecretDigest(saved.id, saved.secret));
      expect((await listLinkShares(env.DB, f.owner, f.tokens)).items).toHaveLength(1);
    }
    expect(fault.fired()).toBe(true);
  },
);
it("keeps link cursors scoped to owner, root and kind", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.create();
  const first = await listLinkShares(env.DB, f.owner, f.tokens, {
    rootNodeId: f.own.ids.folder,
    limit: 2,
  });
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const next = await listLinkShares(env.DB, f.owner, f.tokens, {
    rootNodeId: f.own.ids.folder,
    limit: 2,
    cursor: first.nextCursor!,
  });
  expect(next.items).toHaveLength(1);
  expect(new Set([...first.items, ...next.items].map((s) => s.id)).size).toBe(3);
  await expect(
    listLinkShares(env.DB, f.owner, f.tokens, { cursor: first.nextCursor! }),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listLinkShares(env.DB, f.outsider, f.tokens, {
      rootNodeId: f.own.ids.folder,
      cursor: first.nextCursor!,
    }),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listInternalShares(env.DB, f.owner, f.tokens, {
      rootNodeId: f.own.ids.folder,
      cursor: first.nextCursor!,
    }),
  ).rejects.toThrow("invalid_list_cursor");
});
it("hides a link below a trashed ancestor and rejects creation or updates there", async () => {
  const f = await fixture(),
    input = { ...f.input, rootNodeId: f.own.ids.file },
    saved = await createLinkShare(f.app, f.owner, input),
    op = crypto.randomUUID();
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
  expect((await listLinkShares(env.DB, f.owner, f.tokens)).items).toEqual([]);
  await expect(readLinkShare(env.DB, f.owner, saved.id)).rejects.toThrow("share_unavailable");
  await expect(createLinkShare(f.app, f.owner, input)).rejects.toThrow();
  await expect(updateLinkShare(f.app, f.owner, saved.id, 1, input)).rejects.toThrow();
});
it.each(["ack", "rollback", "reads"] as const)(
  "keeps password/secret rotation atomic after %s",
  async (mode) => {
    const f = await fixture(),
      saved = await f.create("original"),
      before = await env.DB.prepare("SELECT * FROM shares WHERE id=?").bind(saved.id).first(),
      fault = systemMutationFault("share.update:", mode);
    const run = updateLinkShare(
      { ...f.app, DB: fault.db },
      f.owner,
      saved.id,
      1,
      { ...f.input, role: "edit", password: "replacement", rotateSecret: true },
      f.ring,
    );
    if (mode === "ack")
      expect(await run).toMatchObject({ id: saved.id, version: 2, secret: expect.any(String) });
    else await expect(run).rejects.toThrow();
    if (mode === "rollback")
      expect(
        await env.DB.prepare("SELECT * FROM shares WHERE id=?").bind(saved.id).first(),
      ).toEqual(before);
    else {
      expect(await readLinkShare(env.DB, f.owner, saved.id)).toMatchObject({
        version: 2,
        role: "edit",
        hasPassword: true,
      });
      expect(
        await matchesSharePassword(
          saved.id,
          "replacement",
          (await f.passwordRow(saved.id))!,
          f.ring,
        ),
      ).toBe(true);
    }
    expect(fault.fired()).toBe(true);
  },
);
it("routes owned link CRUD through Access/CSRF, hides digests and requires If-Match", async () => {
  const f = await fixture(),
    headers = { "Content-Type": "application/json" };
  const created = await f.http("shares", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...f.input, password: "password" }),
  });
  expect(created.status).toBe(201);
  const saved = (await created.json()) as { id: string; secret: string };
  expect(f.csrf.verify).toHaveBeenCalledOnce();
  expect((await f.http("shares/" + saved.id)).status).toBe(200);
  const list = await f.http("shares?kind=link");
  expect(list.headers.get("Cache-Control")).toBe("private, no-store");
  const text = await list.text();
  expect(text).not.toContain(saved.secret);
  expect(text).not.toContain("passwordDigest");
  expect(text).toContain('"hasPassword":true');
  expect((await f.http("shared-with-me?kind=link")).status).toBe(400);
  expect(
    (
      await f.http("shares/" + saved.id, {
        method: "PATCH",
        headers,
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(428);
  const changed = await f.http("shares/" + saved.id, {
    method: "PATCH",
    headers: { ...headers, "If-Match": '"share-1"' },
    body: JSON.stringify({ ...f.input, password: null, rotateSecret: true }),
  });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("ETag")).toBe('"share-2"');
  expect(
    (
      await f.http("shares/" + saved.id, {
        method: "DELETE",
        headers: { ...headers, "If-Match": '"share-1"' },
      })
    ).status,
  ).toBe(412);
  expect(
    (
      await f.http(
        "shares/" + saved.id,
        { method: "DELETE", headers: { ...headers, "If-Match": '"share-2"' } },
        f.outsider,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.http("shares/" + saved.id, {
        method: "DELETE",
        headers: { ...headers, "If-Match": '"share-2"' },
      })
    ).status,
  ).toBe(200);
  expect((await f.http("shares/" + saved.id)).status).toBe(404);
});
