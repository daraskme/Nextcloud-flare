import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { type CsrfSession, CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";

const origin = "https://app.invalid";
let privateRing: Awaited<ReturnType<typeof csrfKeyRing>>;
let publicRing: Awaited<ReturnType<typeof csrfKeyRing>>;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  privateRing = await csrfKeyRing("private", {
    private: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  publicRing = await csrfKeyRing("public", {
    public: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function request(token?: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/v1/action`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...(token ? { "X-CSRF-Token": token } : {}),
      ...headers,
    },
  });
}
async function fixture(kind: CsrfSession["kind"] = "access") {
  const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, fixture.statements);
  const { ids } = fixture;
  let session: CsrfSession = { kind: "access", credentialId: ids.credential, epoch: 1 };
  if (kind === "share") {
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'upload_only',?)",
        values: [ids.user, ids.user, ids.folder, Date.now()],
      },
      {
        sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
        values: [ids.user, ids.user, ids.user, Date.now(), Date.now() + 600000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
        values: [`ss:${ids.user}`, ids.user],
      },
    ]);
    session = { kind, credentialId: `ss:${ids.user}`, epoch: 1, shareId: ids.user };
  }
  return { ids, session };
}

it("issues without a CSRF token and permits reuse/reissue while the Access session remains live", async () => {
  const f = await fixture();
  const csrf = new CsrfTokens(privateRing, publicRing, origin);
  const issue = request();
  issue.headers.delete("Origin"); // R6 csrf-issue needs Sec-Fetch-Site, not an existing token.
  const one = await csrf.issue(env.DB, issue, f.session);
  const two = await csrf.issue(env.DB, issue, f.session);
  expect(one.token).not.toBe(two.token);
  await csrf.verify(env.DB, request(one.token), f.session);
  await csrf.verify(env.DB, request(one.token), f.session);
  await csrf.verify(env.DB, request(two.token), f.session);
});

it.each(["access", "share"] as const)(
  "binds %s tokens to the current credential, epoch and purpose",
  async (kind) => {
    const f = await fixture(kind);
    const other = await fixture(kind);
    const csrf = new CsrfTokens(privateRing, publicRing, origin);
    const { token } = await csrf.issue(env.DB, request(), f.session);
    await csrf.verify(env.DB, request(token), f.session);
    await expect(csrf.verify(env.DB, request(token), other.session)).rejects.toThrow(
      "csrf_rejected",
    );
    await expect(csrf.verify(env.DB, request(token), { ...f.session, epoch: 2 })).rejects.toThrow();
    if (kind === "share")
      await expect(
        csrf.verify(env.DB, request(token), {
          kind: "access",
          credentialId: f.session.credentialId,
          epoch: 1,
        }),
      ).rejects.toThrow();
    const sql =
      kind === "access"
        ? "UPDATE sessions SET revoked_at=1 WHERE id=?"
        : "UPDATE shares SET version=2 WHERE id=?";
    await env.DB.prepare(sql)
      .bind(kind === "access" ? f.ids.session : f.ids.user)
      .run();
    await expect(csrf.verify(env.DB, request(token), f.session)).rejects.toThrow();
    await expect(csrf.issue(env.DB, request(), f.session)).rejects.toThrow();
  },
);

it.each([
  { Origin: "https://evil.invalid" },
  { Origin: "null" },
  { Origin: "" },
  { "Sec-Fetch-Site": "cross-site" },
  { "Sec-Fetch-Site": "same-site" },
  { "Sec-Fetch-Site": "" },
  { "Content-Type": "text/plain" },
  { "X-CSRF-Token": "" },
])("rejects invalid mutation headers %j", async (headers) => {
  const f = await fixture();
  const csrf = new CsrfTokens(privateRing, publicRing, origin);
  const { token } = await csrf.issue(env.DB, request(), f.session);
  await expect(csrf.verify(env.DB, request(token, headers), f.session)).rejects.toThrow();
});

it("requires same-origin issuance and an unlock session for public CSRF", async () => {
  const f = await fixture("share");
  const csrf = new CsrfTokens(privateRing, publicRing, origin);
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "" }])
    await expect(csrf.issue(env.DB, request(undefined, headers), f.session)).rejects.toThrow();
  await expect(
    csrf.issue(env.DB, request(), { ...f.session, credentialId: "ss:missing" }),
  ).rejects.toThrow();
});

it("expires after exactly one hour and accepts a previous key only while configured", async () => {
  const f = await fixture();
  let time = Date.now();
  const csrf = new CsrfTokens(privateRing, publicRing, origin, () => time);
  const one = await csrf.issue(env.DB, request(), f.session);
  time = one.expiresAt - 1;
  await csrf.verify(env.DB, request(one.token), f.session);
  time = one.expiresAt;
  await expect(csrf.verify(env.DB, request(one.token), f.session)).rejects.toThrow();
  const replacement = await csrfKeyRing("new", {
    new: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const retained = {
    activeKid: replacement.activeKid,
    keys: new Map([...replacement.keys, ...privateRing.keys]),
  };
  await new CsrfTokens(retained, publicRing, origin).verify(env.DB, request(one.token), f.session);
  await expect(
    new CsrfTokens(replacement, publicRing, origin).verify(env.DB, request(one.token), f.session),
  ).rejects.toThrow();
});

it("rejects modified tokens, duplicate token headers and invalid secret sizes", async () => {
  const f = await fixture();
  const csrf = new CsrfTokens(privateRing, publicRing, origin);
  const { token } = await csrf.issue(env.DB, request(), f.session);
  const duplicate = request(token);
  duplicate.headers.append("X-CSRF-Token", token);
  await expect(csrf.verify(env.DB, duplicate, f.session)).rejects.toThrow();
  await expect(csrf.verify(env.DB, request(`A${token.slice(1)}`), f.session)).rejects.toThrow();
  await expect(csrfKeyRing("k", { k: base64url.encode(new Uint8Array(16)) })).rejects.toThrow();
});
