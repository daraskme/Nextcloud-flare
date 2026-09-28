import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleShareHttp } from "../../src/api/shares";
import { accessPrincipal, authorizeNode } from "../../src/auth/authorize";
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
import {
  listLinkShares,
  readLinkShare,
  readUploadOnlyShare,
} from "../../src/services/linkShareRead";
import { createLinkShare, updateLinkShare } from "../../src/services/linkShares";
import { finishReservationStatements, reservationStatements } from "../../src/services/quota";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...f.statements, ...other.statements]);
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const outsider = (await readAccessSession(env.DB, other.ids.credential, 1))!;
  const app = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const ring = {
    ...(await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    })),
    derive: localKdf,
  };
  const tokens = new ListCursorTokens(ring);
  const input = { kind: "upload_only", rootNodeId: f.ids.folder, reservationLimit: 10 };
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
  const create = (extra: Record<string, unknown> = {}) =>
    createLinkShare(app, owner, { ...input, ...extra }, ring);
  return { f, other, owner, outsider, app, ring, tokens, input, csrf, http, create };
}
it.each([undefined, "秘密🔑"])(
  "creates a folder receipt link with password=%s and no read grant",
  async (password) => {
    const t = await fixture();
    const saved = await t.create(password ? { password } : {});
    const share = await readUploadOnlyShare(env.DB, t.owner, saved.id);
    expect(share).toEqual({
      id: saved.id,
      kind: "upload_only",
      rootNodeId: t.f.ids.folder,
      spaceId: t.f.ids.space,
      ownerId: t.f.ids.user,
      name: "Folder",
      nodeKind: "folder",
      version: 1,
      createdAt: expect.any(Number),
      expiresAt: null,
      hasPassword: !!password,
      reservationLimit: 10,
      reservedBytes: 0,
    });
    const stored = await env.DB.prepare(
      "SELECT secret_digest,password_digest AS passwordDigest,salt,kdf,kdf_params AS kdfParams,kid FROM shares WHERE id=?",
    )
      .bind(saved.id)
      .first<{ secret_digest: string } & SharePasswordRecord>();
    expect(stored!.secret_digest).toBe(await shareSecretDigest(saved.id, saved.secret));
    expect(JSON.stringify(share)).not.toContain(saved.secret);
    if (password)
      expect(await matchesSharePassword(saved.id, password, stored!, t.ring)).toBe(true);
    expect(
      (
        await env.DB.prepare("SELECT action FROM share_actions WHERE share_id=? ORDER BY action")
          .bind(saved.id)
          .all()
      ).results,
    ).toEqual([{ action: "create" }, { action: "upload" }]);
    expect((await listLinkShares(env.DB, t.owner, t.tokens, {}, "upload_only")).items).toEqual([
      share,
    ]);
    expect((await listLinkShares(env.DB, t.owner, t.tokens)).items).toEqual([]);
    expect((await listInternalShares(env.DB, t.owner, t.tokens)).items).toEqual([]);
    await expect(readLinkShare(env.DB, t.owner, saved.id)).rejects.toThrow("share_unavailable");
  },
);
it("rejects a file root, other owner's root and conversion between share kinds", async () => {
  const t = await fixture();
  await expect(t.create({ rootNodeId: t.f.ids.file })).rejects.toThrow("invalid_share_request");
  await expect(t.create({ rootNodeId: t.other.ids.folder })).rejects.toThrow("share_unavailable");
  const saved = await t.create();
  await expect(
    updateLinkShare(t.app, t.owner, saved.id, 1, {
      kind: "link",
      rootNodeId: t.f.ids.folder,
      role: "edit",
    }),
  ).rejects.toThrow("invalid_share_request");
  await expect(
    updateLinkShare(t.app, t.owner, saved.id, 1, { ...t.input, rootNodeId: t.f.ids.root }),
  ).rejects.toThrow("invalid_share_request");
  const link = await createLinkShare(t.app, t.owner, {
    kind: "link",
    rootNodeId: t.f.ids.folder,
    role: "edit",
  });
  await expect(updateLinkShare(t.app, t.owner, link.id, 1, t.input)).rejects.toThrow(
    "invalid_share_request",
  );
  await expect(readUploadOnlyShare(env.DB, t.outsider, saved.id)).rejects.toThrow(
    "share_unavailable",
  );
  await expect(updateLinkShare(t.app, t.outsider, saved.id, 1, null)).rejects.toThrow(
    "share_unavailable",
  );
  expect((await listLinkShares(env.DB, t.outsider, t.tokens, {}, "upload_only")).items).toEqual([]);
});
it("reserves both quotas atomically and retains outstanding bytes across limit reduction and disable", async () => {
  const t = await fixture(),
    saved = await t.create();
  const reserve = (id: string, bytes: number, version = 1) =>
    atomicBatch(
      env.DB,
      reservationStatements({
        id,
        ownerId: t.f.ids.user,
        bytes,
        expiresAt: Date.now() + 60000,
        epoch: 1,
        share: { id: saved.id, version },
      }),
    );
  const reservation = crypto.randomUUID();
  await reserve(reservation, 8);
  await expect(reserve(crypto.randomUUID(), 3)).rejects.toThrow("share_quota_exceeded");
  expect((await readUploadOnlyShare(env.DB, t.owner, saved.id)).reservedBytes).toBe(8);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(t.f.ids.user)
      .first("reserved_bytes"),
  ).toBe(8);
  await updateLinkShare(t.app, t.owner, saved.id, 1, { ...t.input, reservationLimit: 3 });
  expect(await readUploadOnlyShare(env.DB, t.owner, saved.id)).toMatchObject({
    version: 2,
    reservationLimit: 3,
    reservedBytes: 8,
  });
  await expect(reserve(crypto.randomUUID(), 0, 1)).rejects.toThrow();
  await expect(reserve(crypto.randomUUID(), 1, 2)).rejects.toThrow("share_quota_exceeded");
  await updateLinkShare(t.app, t.owner, saved.id, 2, null);
  await expect(reserve(crypto.randomUUID(), 0, 3)).rejects.toThrow();
  await atomicBatch(env.DB, finishReservationStatements(reservation, t.f.ids.user, 1, "released"));
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(saved.id)
      .first("reserved_bytes"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(t.f.ids.user)
      .first("reserved_bytes"),
  ).toBe(0);
});
it("rotates secrets and revokes sessions without refunding reservations", async () => {
  const t = await fixture(),
    saved = await t.create({ password: "keep" }),
    now = Date.now(),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
  )
    .bind(id, saved.id, id, now, now + 60000)
    .run();
  const password = await env.DB.prepare("SELECT password_digest FROM shares WHERE id=?")
    .bind(saved.id)
    .first("password_digest");
  const next = await updateLinkShare(
    t.app,
    t.owner,
    saved.id,
    1,
    { ...t.input, rotateSecret: true },
    t.ring,
  );
  expect(next.secret).not.toBe(saved.secret);
  expect(
    await env.DB.prepare("SELECT revoked_at FROM share_sessions WHERE id=?")
      .bind(id)
      .first("revoked_at"),
  ).toEqual(expect.any(Number));
  expect(
    await env.DB.prepare("SELECT password_digest FROM shares WHERE id=?")
      .bind(saved.id)
      .first("password_digest"),
  ).toBe(password);
  await updateLinkShare(t.app, t.owner, saved.id, 2, { ...t.input, password: null }, t.ring);
  expect((await readUploadOnlyShare(env.DB, t.owner, saved.id)).hasPassword).toBe(false);
});
it.each(["session", "owner", "root", "maintenance", "epoch"])(
  "rolls back creation after a %s change at commit",
  async (change) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO shares("),
      async () => {
        if (change === "session")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(t.f.ids.session)
            .run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(t.f.ids.user)
            .run();
        if (change === "root")
          await env.DB.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?")
            .bind(t.f.ids.folder)
            .run();
        if (change === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
      },
      false,
    );
    await expect(createLinkShare({ ...t.app, DB: db }, t.owner, t.input)).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id=?")
        .bind(t.f.ids.user)
        .first("n"),
    ).toBe(0);
  },
);
it("pages owner listings without accepting another share kind's cursor", async () => {
  const t = await fixture();
  await t.create();
  await t.create();
  const first = await listLinkShares(env.DB, t.owner, t.tokens, { limit: 1 }, "upload_only");
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  const second = await listLinkShares(
    env.DB,
    t.owner,
    t.tokens,
    { limit: 1, cursor: first.nextCursor! },
    "upload_only",
  );
  expect(second.items).toHaveLength(1);
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  expect(second.nextCursor).toBeNull();
  await expect(
    listLinkShares(env.DB, t.owner, t.tokens, { cursor: first.nextCursor! }),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listLinkShares(
      env.DB,
      t.owner,
      t.tokens,
      { cursor: first.nextCursor!, rootNodeId: t.f.ids.folder },
      "upload_only",
    ),
  ).rejects.toThrow("invalid_list_cursor");
});
it("connects owner HTTP create/read/list/update/disable with CSRF and version checks", async () => {
  const t = await fixture();
  const headers = { "Content-Type": "application/json" };
  const created = await t.http("shares", {
    method: "POST",
    headers,
    body: JSON.stringify(t.input),
  });
  expect(created.status).toBe(201);
  const saved = await created.json<{ id: string; secret: string }>();
  const detail = await t.http(`shares/${saved.id}`);
  expect(detail.status).toBe(200);
  expect(detail.headers.get("ETag")).toBe('"share-1"');
  expect(await detail.json()).toMatchObject({
    kind: "upload_only",
    reservationLimit: 10,
    reservedBytes: 0,
  });
  expect(await (await t.http("shares?kind=upload_only")).json()).toMatchObject({
    items: [{ id: saved.id }],
  });
  expect((await t.http("shared-with-me?kind=upload_only")).status).toBe(400);
  expect(
    (
      await t.http(`shares/${saved.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(t.input),
      })
    ).status,
  ).toBe(428);
  t.csrf.verify.mockRejectedValueOnce(new Error("csrf_rejected"));
  expect(
    (
      await t.http(`shares/${saved.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": '"share-1"' },
        body: JSON.stringify(t.input),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await t.http(`shares/${saved.id}`, {
        method: "PATCH",
        headers: { ...headers, "If-Match": '"share-1"' },
        body: JSON.stringify({ ...t.input, reservationLimit: 0 }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await t.http(`shares/${saved.id}`, { method: "DELETE", headers: { "If-Match": '"share-1"' } }))
      .status,
  ).toBe(412);
  expect(
    (await t.http(`shares/${saved.id}`, { method: "DELETE", headers: { "If-Match": '"share-2"' } }))
      .status,
  ).toBe(200);
  expect((await t.http(`shares/${saved.id}`)).status).toBe(404);
  await expect(
    authorizeNode(env.DB, accessPrincipal(t.outsider), {
      operation: "node.read",
      spaceId: t.f.ids.space,
      nodeId: t.f.ids.folder,
    }),
  ).rejects.toThrow("authorization_denied");
});
