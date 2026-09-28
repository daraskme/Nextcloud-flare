import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { KdfUnavailableError } from "../../src/auth/kdf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { createLinkShare, updateLinkShare } from "../../src/services/linkShares";
import { logoutShare, readShareSession, unlockShare } from "../../src/services/shareUnlock";
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
const origin = "https://app.invalid";
async function fixture(password?: string) {
  const own = foundationFixture(crypto.randomUUID(), Date.now() - 1000),
    other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...own.statements, ...other.statements]);
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    ring = await contentKeyRing("v1", { v1: key });
  const passwords = { ...ring, derive: vi.fn(localKdf) };
  const tokens = new ShareTokens(ring, origin),
    csrf = new CsrfTokens({ activeKid: "unused", keys: new Map() }, ring, origin);
  const owner = (await readAccessSession(env.DB, own.ids.credential, 1))!;
  const base = mutationEnv(),
    rate = vi.fn(async () => ({ allowed: true as const }));
  const app: Env = {
    ...base,
    APP_ORIGIN: origin,
    EDGE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CONTROL: {
      idFromName: base.CONTROL.idFromName,
      get: (id: DurableObjectId) => ({ ...base.CONTROL.get(id), admitShareUnlock: rate }),
    } as unknown as Env["CONTROL"],
  };
  const input = { kind: "link", rootNodeId: own.ids.folder, role: "read", expiresAt: null };
  const saved = await createLinkShare(
    app,
    owner,
    { ...input, ...(password ? { password } : {}) },
    passwords,
  );
  passwords.derive.mockClear();
  const challenge = await tokens.challenge(saved.id, 1);
  const deps = { tokens, csrf, passwords };
  const request = (
    action: string,
    value?: unknown,
    cookie?: string,
    token?: string,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${origin}/api/v1/public/shares/${saved.id}/${action}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "CF-Connecting-IP": "192.0.2.1",
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { "X-CSRF-Token": token } : {}),
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const http = (r: Request, e = app) => handlePublicShareHttp(r, e, 1, deps);
  const begin = async () => {
    const response = await http(request("unlock", { step: "challenge" }));
    expect(response.status).toBe(200);
    const result = await response.json<{ token: string }>();
    return { token: result.token, cookie: response.headers.get("Set-Cookie")!.split(";")[0]! };
  };
  const login = () =>
    unlockShare(
      app,
      challenge.claims,
      { secret: saved.secret, ...(password ? { password } : {}) },
      passwords,
    );
  const count = () =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM share_sessions WHERE share_id=?")
      .bind(saved.id)
      .first<number>("n");
  return {
    own,
    other,
    owner,
    app,
    saved,
    input,
    passwords,
    tokens,
    challenge,
    request,
    http,
    begin,
    login,
    count,
    rate,
    deps,
    key,
  };
}
it.each([undefined, "p🔑ass"])(
  "issues a bounded anonymous credential only after capability and password verification: %s",
  async (password) => {
    const f = await fixture(password),
      session = await f.login();
    expect(session.claims.exp - session.claims.iat).toBe(604800);
    expect(await f.count()).toBe(1);
    expect(await readShareSession(env.DB, session.claims)).toEqual(session);
    const stored = await env.DB.prepare("SELECT * FROM share_sessions WHERE id=?")
      .bind(session.claims.session_id)
      .first();
    expect(stored).toMatchObject({ share_id: f.saved.id, user_id: null, revoked_at: null });
    expect(JSON.stringify(stored)).not.toContain(f.saved.secret);
    expect(JSON.stringify(stored)).not.toContain(f.challenge.claims.nonce);
    const principal = {
      kind: "link_share" as const,
      share_id: f.saved.id,
      share_version: 1,
      credential_id: `ss:${session.claims.session_id}`,
      epoch: 1,
    };
    expect(
      (
        await authorizeNode(env.DB, principal, {
          operation: "node.read",
          nodeId: f.own.ids.folder,
          spaceId: f.own.ids.space,
        })
      ).principal,
    ).toEqual(principal);
    await expect(
      authorizeNode(env.DB, principal, {
        operation: "node.read",
        nodeId: f.own.ids.root,
        spaceId: f.own.ids.space,
      }),
    ).rejects.toThrow();
  },
);
it("clamps session expiry to the current share expiry", async () => {
  const f = await fixture();
  const expires = Date.now() + 60000;
  await env.DB.prepare("UPDATE shares SET expires_at=? WHERE id=?").bind(expires, f.saved.id).run();
  const s = await f.login();
  expect(s.claims.exp * 1000).toBe(Math.floor(expires / 1000) * 1000);
});
it("reuses the same session for concurrent submissions and never resurrects its tombstone", async () => {
  const f = await fixture(),
    [one, two] = await Promise.all([f.login(), f.login()]);
  expect(two).toEqual(one);
  expect(await f.count()).toBe(1);
  expect(await f.login()).toEqual(one);
  await logoutShare(f.app, one);
  await expect(f.login()).rejects.toThrow("share_session_unavailable");
  expect(await f.count()).toBe(1);
});
it("never performs password work for a wrong capability and distinguishes KDF failure", async () => {
  const f = await fixture("password");
  await expect(
    unlockShare(
      f.app,
      f.challenge.claims,
      { secret: base64url.encode(new Uint8Array(32)), password: "password" },
      f.passwords,
    ),
  ).rejects.toThrow("share_unlock_rejected");
  expect(f.passwords.derive).not.toHaveBeenCalled();
  await expect(
    unlockShare(
      f.app,
      f.challenge.claims,
      { secret: f.saved.secret, password: "wrong" },
      f.passwords,
    ),
  ).rejects.toThrow("share_unlock_rejected");
  f.passwords.derive.mockRejectedValueOnce(new KdfUnavailableError());
  await expect(f.login()).rejects.toBeInstanceOf(KdfUnavailableError);
  expect(await f.count()).toBe(0);
});
it.each(["version", "secret", "password", "trash", "owner", "expiry", "epoch", "maintenance"])(
  "rolls back registration after a concurrent %s change",
  async (change) => {
    const f = await fixture();
    const db = injectBatch(
      () => true,
      async () => {
        if (change === "version")
          await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
            .bind(f.saved.id)
            .run();
        if (change === "secret")
          await env.DB.prepare("UPDATE shares SET secret_digest='changed' WHERE id=?")
            .bind(f.saved.id)
            .run();
        if (change === "password")
          await env.DB.prepare(
            "UPDATE shares SET password_digest='changed',salt='salt',kdf='PBKDF2-SHA256',kdf_params=?,kid='v1' WHERE id=?",
          )
            .bind('{"iterations":100000}', f.saved.id)
            .run();
        if (change === "trash")
          await env.DB.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?")
            .bind(f.own.ids.root)
            .run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(f.own.ids.user)
            .run();
        if (change === "expiry")
          await env.DB.prepare("UPDATE shares SET expires_at=1 WHERE id=?").bind(f.saved.id).run();
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
      },
      false,
    );
    await expect(
      unlockShare({ ...f.app, DB: db }, f.challenge.claims, { secret: f.saved.secret }),
    ).rejects.toThrow();
    expect(await f.count()).toBe(0);
  },
);
it("rejects a share revoked during the KDF before creating a session", async () => {
  const f = await fixture("password");
  f.passwords.derive.mockImplementationOnce(async (...args) => {
    const result = await localKdf(...args);
    await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(f.saved.id).run();
    return result;
  });
  await expect(f.login()).rejects.toThrow();
  expect(await f.count()).toBe(0);
});
it.each(["ack", "rollback", "reads"] as const)(
  "recovers a %s outcome through the same signed challenge without a replacement identity",
  async (mode) => {
    const f = await fixture(),
      fault = systemMutationFault("session.register:", mode);
    const run = unlockShare({ ...f.app, DB: fault.db }, f.challenge.claims, {
      secret: f.saved.secret,
    });
    if (mode === "ack") await expect(run).resolves.toMatchObject({ rootNodeId: f.own.ids.folder });
    else await expect(run).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(await f.count()).toBe(mode === "rollback" ? 0 : 1);
    const current = await f.login();
    expect(await f.count()).toBe(1);
    expect(await f.login()).toEqual(current);
  },
);
it("performs the full challenge, unlock, CSRF and logout HTTP flow without Access", async () => {
  const f = await fixture("password"),
    challenge = await f.begin();
  const unlocked = await f.http(
    f.request(
      "unlock",
      { secret: f.saved.secret, password: "password" },
      challenge.cookie,
      challenge.token,
    ),
  );
  expect(unlocked.status).toBe(200);
  expect(unlocked.headers.get("Cache-Control")).toBe("private, no-store");
  const result = await unlocked.json();
  expect(result).toMatchObject({
    unlocked: true,
    id: f.saved.id,
    version: 1,
    rootNodeId: f.own.ids.folder,
  });
  expect(JSON.stringify(result)).not.toContain("nonce");
  const cookie = unlocked.headers.get("Set-Cookie")!.split(";")[0]!;
  const issue = await f.http(f.request("csrf", undefined, cookie));
  expect(issue.status).toBe(200);
  const csrf = await issue.json<{ token: string }>();
  const resumed = await f.http(f.request("unlock", { step: "challenge" }, cookie));
  expect(await resumed.json()).toEqual(result);
  expect(await f.count()).toBe(1);
  expect(f.rate).toHaveBeenCalledOnce();
  expect(f.passwords.derive).toHaveBeenCalledOnce();
  const logout = await f.http(f.request("logout", {}, cookie, csrf.token));
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await f.http(f.request("csrf", undefined, cookie))).status).toBe(401);
  const replay = await f.http(
    f.request(
      "unlock",
      { secret: f.saved.secret, password: "password" },
      challenge.cookie,
      challenge.token,
    ),
  );
  expect(replay.status).toBe(401);
  expect(await f.count()).toBe(1);
});
it.each([
  { Origin: "https://evil.invalid" },
  { Origin: "null" },
  { Origin: "" },
  { "Sec-Fetch-Site": "cross-site" },
  { "Sec-Fetch-Site": "" },
])("rejects hostile public headers %j before the rate backend or KDF", async (headers) => {
  const f = await fixture("password"),
    c = await f.begin();
  expect(
    (
      await f.http(
        f.request(
          "unlock",
          { secret: f.saved.secret, password: "password" },
          c.cookie,
          c.token,
          headers,
        ),
      )
    ).status,
  ).toBe(403);
  expect(f.rate).not.toHaveBeenCalled();
  expect(f.passwords.derive).not.toHaveBeenCalled();
});
it("requires the same challenge cookie and header and never permits private CSRF as a substitute", async () => {
  const f = await fixture(),
    c = await f.begin(),
    body = { secret: f.saved.secret };
  for (const [cookie, token] of [
    [undefined, c.token],
    [c.cookie, undefined],
    [c.cookie, "wrong"],
    [`${c.cookie}; ${c.cookie}`, c.token],
  ])
    expect((await f.http(f.request("unlock", body, cookie, token))).status).toBe(403);
  expect(f.rate).not.toHaveBeenCalled();
  expect(await f.count()).toBe(0);
});
it("returns the same credential error for missing, expired and wrong-secret links", async () => {
  const f = await fixture(),
    c = await f.begin();
  const wrong = await f.http(f.request("unlock", { secret: "bad" }, c.cookie, c.token));
  await env.DB.prepare("UPDATE shares SET expires_at=1 WHERE id=?").bind(f.saved.id).run();
  const expired = await f.http(f.request("unlock", { secret: f.saved.secret }, c.cookie, c.token));
  expect(wrong.status).toBe(401);
  expect(expired.status).toBe(401);
  expect(await wrong.text()).toEqual(await expired.text());
  expect(await f.count()).toBe(0);
});
it("fails closed on rate denial/unknown outcome and never starts a KDF", async () => {
  const f = await fixture("password"),
    c = await f.begin();
  f.rate.mockResolvedValueOnce({ allowed: false, retryAfter: 12 } as never);
  const denied = await f.http(
    f.request("unlock", { secret: f.saved.secret, password: "password" }, c.cookie, c.token),
  );
  expect(denied.status).toBe(429);
  expect(denied.headers.get("Retry-After")).toBe("12");
  f.rate.mockRejectedValueOnce(new Error("lost RPC"));
  expect(
    (
      await f.http(
        f.request("unlock", { secret: f.saved.secret, password: "password" }, c.cookie, c.token),
      )
    ).status,
  ).toBe(503);
  expect(f.rate).toHaveBeenCalledTimes(2);
  expect(f.passwords.derive).not.toHaveBeenCalled();
  expect(await f.count()).toBe(0);
});
it("invalidates issued cookies and CSRF when the owner changes the share", async () => {
  const f = await fixture(),
    s = await f.login(),
    cookie = `__Host-ncf_share_${f.saved.id}=${await f.tokens.issue(s.claims)}`;
  const token = await (await f.http(f.request("csrf", undefined, cookie))).json<{
    token: string;
  }>();
  await updateLinkShare(f.app, f.owner, f.saved.id, 1, { ...f.input, role: "edit" });
  expect((await f.http(f.request("csrf", undefined, cookie))).status).toBe(401);
  expect((await f.http(f.request("logout", {}, cookie, token.token))).status).toBe(401);
  await expect(readShareSession(env.DB, s.claims)).rejects.toThrow();
});
it.each(["ack", "rollback", "reads"] as const)(
  "keeps logout, derived revocation and budget preservation atomic after %s loss",
  async (mode) => {
    const f = await fixture(),
      session = await f.login(),
      another = await f.tokens.challenge(f.saved.id, 1);
    const other = await unlockShare(f.app, another.claims, { secret: f.saved.secret });
    const id = crypto.randomUUID(),
      now = Date.now(),
      credential = `ss:${session.claims.session_id}`;
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO budgets(id,owner_id,share_id,unlock_session_id,epoch,expires_at,state) VALUES(?,?,?,?,1,?,'active')",
        values: [id, f.own.ids.user, f.saved.id, session.claims.session_id, now + 60000],
      },
      {
        sql: "INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch) VALUES(?,?,?,'hash','ref',0,?,1)",
        values: [id, f.own.ids.user, credential, now + 60000],
      },
      {
        sql: "INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at) VALUES(?,?,?,?,'content',1,?,?)",
        values: [id, credential, id, id, now, now + 60000],
      },
      {
        sql: "INSERT INTO content_sessions(id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,epoch,issued_at,expires_at,ticket_id) VALUES(?,?,1,?,?,?,1,?,?,?)",
        values: [id, f.saved.id, credential, id, id, now, now + 60000, id],
      },
    ]);
    const budget = await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(id).first();
    const fault = systemMutationFault("session.revoke:", mode),
      run = logoutShare({ ...f.app, DB: fault.db }, session);
    if (mode === "ack") await run;
    else await expect(run).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    for (const [table, column, row] of [
      ["share_sessions", "revoked_at", session.claims.session_id],
      ["content_sessions", "revoked_at", id],
      ["tickets", "cancelled_at", id],
    ]) {
      const result = await env.DB.prepare(`SELECT ${column} FROM ${table} WHERE id=?`)
        .bind(row!)
        .first(column!);
      if (mode === "rollback") expect(result).toBeNull();
      else expect(result).toEqual(expect.any(Number));
    }
    expect(await env.DB.prepare("SELECT * FROM budgets WHERE id=?").bind(id).first()).toEqual(
      budget,
    );
    expect(await readShareSession(env.DB, other.claims)).toEqual(other);
  },
);
it("dispatches the public route with public-only configuration and refuses other hosts/query credentials", async () => {
  const f = await fixture();
  const configured = {
    ...f.app,
    SHARE_COOKIE_KEYS: JSON.stringify({ v1: f.key }),
    SHARE_COOKIE_ACTIVE_KID: "v1",
    CSRF_PUBLIC_KEYS: JSON.stringify({ v1: f.key }),
    CSRF_PUBLIC_ACTIVE_KID: "v1",
  };
  expect((await worker.fetch(f.request("unlock", { step: "challenge" }), configured)).status).toBe(
    200,
  );
  expect((await worker.fetch(f.request("unlock", { step: "challenge" }), f.app)).status).toBe(503);
  expect((await f.http(f.request("unlock?secret=forbidden", { step: "challenge" }))).status).toBe(
    400,
  );
  expect(
    (
      await worker.fetch(
        new Request("https://other.invalid/api/v1/public/shares/x/unlock", { method: "POST" }),
        configured,
      )
    ).status,
  ).toBe(404);
});
