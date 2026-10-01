import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { handleAccountHttp } from "../../src/api/account";
import { handleInviteHttp } from "../../src/api/invites";
import { createAccessInvite } from "../../src/auth/invites";
import { loginAccessUser } from "../../src/auth/login";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,bootstrap_done_at=1").run();
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM access_invites WHERE id LIKE 'cap-%'").run();
});

async function fixture() {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, owner.statements);
  const session: AccessSession = {
    user_id: owner.ids.user,
    credential_id: owner.ids.credential,
    session_id: owner.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const access = await accessFixture();
  const app = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    ACCESS_ISSUER: access.issuer,
  } as Env;
  const csrf = { verify: async () => {} };
  const invite = (email: string) => createAccessInvite(app, session, email, access.issuer);
  const login = async (sub: string, email: string) =>
    loginAccessUser(app, access.verifier, await access.sign({ sub, email }), 1, {
      ownerEmails: [],
      ownerIdentities: [],
      quotaBytes: 0,
    });
  return { owner, session, access, app, csrf, invite, login };
}

it("requires an explicit invitation, then binds two exact emails to distinct Access subjects", async () => {
  const f = await fixture();
  const firstEmail = `first-${crypto.randomUUID()}@example.invalid`;
  const secondEmail = `second-${crypto.randomUUID()}@example.invalid`;
  await expect(f.login("first", firstEmail)).rejects.toThrow("credential_inactive");
  await f.invite(firstEmail);
  await f.invite(secondEmail);
  const first = await f.login("first", firstEmail);
  const second = await f.login("second", secondEmail);
  const me = await handleAccountHttp(
    new Request("https://app.invalid/api/v1/me"),
    f.app,
    first,
    f.csrf,
  );
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: first.user_id, role: "member", email: firstEmail });
  expect(first.user_id).not.toBe(second.user_id);
  expect(first.role).toBe("member");
  expect(second.role).toBe("member");
  expect(await f.login("first", firstEmail)).toMatchObject({ user_id: first.user_id });
  const rows = (
    await env.DB.prepare(
      "SELECT u.id,u.access_sub,u.role,u.quota_bytes,s.root_node_id FROM users u JOIN spaces s ON s.owner_id=u.id WHERE u.id IN (?,?) ORDER BY u.access_sub",
    )
      .bind(first.user_id, second.user_id)
      .all()
  ).results;
  expect(rows).toEqual([
    {
      id: first.user_id,
      access_sub: "first",
      role: "member",
      quota_bytes: 1_073_741_824,
      root_node_id: expect.any(String),
    },
    {
      id: second.user_id,
      access_sub: "second",
      role: "member",
      quota_bytes: 1_073_741_824,
      root_node_id: expect.any(String),
    },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM access_invites WHERE claimed_at IS NOT NULL AND claimed_user_id IN (?,?)",
    )
      .bind(first.user_id, second.user_id)
      .first("n"),
  ).toBe(2);
});

it("does not merge a new subject with an invited email after first claim", async () => {
  const f = await fixture();
  const email = `exclusive-${crypto.randomUUID()}@example.invalid`;
  await f.invite(email);
  const original = await f.login("original", email);
  await expect(f.login("replacement", email)).rejects.toThrow("credential_inactive");
  await expect(f.invite(email)).rejects.toThrow("invite_conflict");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(email)=?")
      .bind(email)
      .first("n"),
  ).toBe(1);
  expect(await f.login("original", email)).toMatchObject({ user_id: original.user_id });
});

it("requires the Access email to match the approved spelling exactly", async () => {
  const f = await fixture();
  const email = `Case-${crypto.randomUUID()}@example.invalid`;
  await f.invite(email);
  await expect(f.invite(email.toLowerCase())).rejects.toThrow("invite_conflict");
  await expect(f.login("case-mismatch", email.toLowerCase())).rejects.toThrow(
    "credential_inactive",
  );
  expect((await f.login("case-exact", email)).role).toBe("member");
});

it("revokes an expired pending invitation atomically before approving the same email again", async () => {
  const f = await fixture();
  const email = `renew-${crypto.randomUUID()}@example.invalid`;
  const old = await f.invite(email);
  await expect(f.invite(email)).rejects.toThrow("invite_conflict");
  await env.DB.prepare(
    "UPDATE access_invites SET created_at=1,expires_at=strftime('%s','now')*1000 WHERE id=?",
  )
    .bind(old.id)
    .run();
  const renewed = await f.invite(email);
  expect(renewed.id).not.toBe(old.id);
  expect(
    await env.DB.prepare("SELECT revoked_at FROM access_invites WHERE id=?")
      .bind(old.id)
      .first("revoked_at"),
  ).toEqual(expect.any(Number));
  const listing = await handleInviteHttp(
    new Request("https://app.invalid/api/v1/admin/invites"),
    f.app,
    f.session,
    f.csrf,
  );
  expect(listing.status).toBe(200);
  const body = await listing.json<{ invites: { id: string }[] }>();
  expect(body.invites.map((item) => item.id)).toContain(renewed.id);
  expect(body.invites.map((item) => item.id)).not.toContain(old.id);
  expect((await f.login("renewed", email)).role).toBe("member");
});

it("serializes concurrent re-approval at the expiry boundary", async () => {
  const f = await fixture();
  const email = `renew-race-${crypto.randomUUID()}@example.invalid`;
  const old = await f.invite(email);
  await env.DB.prepare(
    "UPDATE access_invites SET created_at=1,expires_at=strftime('%s','now')*1000 WHERE id=?",
  )
    .bind(old.id)
    .run();
  const results = await Promise.allSettled([f.invite(email), f.invite(email)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_invites
    WHERE lower(email)=lower(?) AND revoked_at IS NULL AND claimed_at IS NULL`)
      .bind(email)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT revoked_at FROM access_invites WHERE id=?")
      .bind(old.id)
      .first("revoked_at"),
  ).toEqual(expect.any(Number));
});

it("lists active pending invitations even after more than 200 historic rows", async () => {
  const f = await fixture();
  const pending = await f.invite(`visible-${crypto.randomUUID()}@example.invalid`);
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<205)
    INSERT INTO access_invites(id,access_iss,email,approved_by,created_at,expires_at,revoked_at)
    SELECT 'historic-'||?||'-'||i,'https://access.invalid',
      'historic-'||?||'-'||i||'@example.invalid',?,?+i,?+i+604800000,1 FROM n`)
    .bind(crypto.randomUUID(), crypto.randomUUID(), f.session.user_id, Date.now(), Date.now())
    .run();
  const listing = await handleInviteHttp(
    new Request("https://app.invalid/api/v1/admin/invites"),
    f.app,
    f.session,
    f.csrf,
  );
  const body = await listing.json<{ invites: { id: string }[] }>();
  expect(body.invites.map((item) => item.id)).toContain(pending.id);
  expect(body.invites.some((item) => item.id.startsWith("historic-"))).toBe(false);
});

it("caps active pending invitations at the number returned by the admin list", async () => {
  const f = await fixture();
  const active = await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_invites
    WHERE revoked_at IS NULL AND claimed_at IS NULL AND expires_at>strftime('%s','now')*1000`).first<number>(
    "n",
  );
  const remaining = 200 - (active ?? 0);
  expect(remaining).toBeGreaterThan(0);
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO access_invites(id,access_iss,email,approved_by,created_at,expires_at)
    SELECT 'cap-'||?||'-'||i,'https://access.invalid',
      'cap-'||?||'-'||i||'@example.invalid',?,?,? FROM n`)
    .bind(
      remaining,
      crypto.randomUUID(),
      crypto.randomUUID(),
      f.session.user_id,
      Date.now(),
      Date.now() + 604800000,
    )
    .run();
  const listing = await handleInviteHttp(
    new Request("https://app.invalid/api/v1/admin/invites"),
    f.app,
    f.session,
    f.csrf,
  );
  const body = await listing.json<{ invites: { id: string }[] }>();
  expect(body.invites).toHaveLength(200);
  await expect(f.invite(`over-cap-${crypto.randomUUID()}@example.invalid`)).rejects.toThrow(
    "invite_conflict",
  );
});

it("allows only one subject to consume an invite during concurrent first logins", async () => {
  const f = await fixture();
  const email = `race-${crypto.randomUUID()}@example.invalid`;
  await f.invite(email);
  const results = await Promise.allSettled([f.login("racer-a", email), f.login("racer-b", email)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const row = await env.DB.prepare(
    "SELECT u.access_sub FROM access_invites i JOIN users u ON u.id=i.claimed_user_id WHERE i.email=?",
  )
    .bind(email)
    .first<{ access_sub: string }>();
  expect(["racer-a", "racer-b"]).toContain(row?.access_sub);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email=?").bind(email).first("n"),
  ).toBe(1);
});

it("rejects wrong issuer, expired and revoked invites", async () => {
  const f = await fixture();
  const email = `guard-${crypto.randomUUID()}@example.invalid`;
  const invite = await f.invite(email);
  const other = await accessFixture("https://other.invalid");
  await expect(
    loginAccessUser(f.app, other.verifier, await other.sign({ sub: "wrong", email }), 1, {
      ownerEmails: [],
      ownerIdentities: [],
      quotaBytes: 0,
    }),
  ).rejects.toThrow("credential_inactive");
  await env.DB.prepare("UPDATE access_invites SET created_at=1,expires_at=2 WHERE id=?")
    .bind(invite.id)
    .run();
  await expect(f.login("expired", email)).rejects.toThrow("credential_inactive");
  await env.DB.prepare("UPDATE access_invites SET expires_at=? WHERE id=?")
    .bind(Date.now() + 60000, invite.id)
    .run();
  const response = await handleInviteHttp(
    new Request(`https://app.invalid/api/v1/admin/invites/${invite.id}`, { method: "DELETE" }),
    f.app,
    f.session,
    f.csrf,
  );
  expect(response.status).toBe(204);
  await expect(f.login("revoked", email)).rejects.toThrow("credential_inactive");
});

it("checks live admin authority, CSRF, and existing email before approval or claim", async () => {
  const f = await fixture();
  const email = `authority-${crypto.randomUUID()}@example.invalid`;
  const denied = await handleInviteHttp(
    new Request("https://app.invalid/api/v1/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    f.app,
    f.session,
    {
      verify: async () => {
        throw new Error("csrf");
      },
    },
  );
  expect(denied.status).toBe(403);
  const invite = await f.invite(email);
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.session.user_id).run();
  await expect(f.login("late", email)).rejects.toThrow("credential_inactive");
  expect(
    await env.DB.prepare("SELECT claimed_at FROM access_invites WHERE id=?")
      .bind(invite.id)
      .first("claimed_at"),
  ).toBeNull();
  await expect(f.invite(`new-${crypto.randomUUID()}@example.invalid`)).rejects.toThrow();
});
