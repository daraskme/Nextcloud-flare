import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  assertLiveAccessCredential,
  readAccessSession,
  registerAccessSession,
  revokeAccessSession,
} from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture() {
  const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, fixture.statements);
  const iat = Math.floor(Date.now() / 1000) - 1;
  return {
    ...fixture,
    claims: { iss: "https://access.invalid", sub: fixture.ids.user, iat, exp: iat + 3600 },
  };
}

it("registers one durable session under racing logins for the same JWT", async () => {
  const { claims } = await fixture();
  const sessions = await Promise.all([
    registerAccessSession(mutationEnv(), claims, 1),
    registerAccessSession(mutationEnv(), claims, 1),
  ]);
  expect(sessions[0]?.credential_id).toBe(sessions[1]?.credential_id);
  expect(sessions[0]?.credential_id).toMatch(/^as:/);
});

it("does not merge different issuer/sub identities by email", async () => {
  const { claims } = await fixture();
  await expect(
    registerAccessSession(mutationEnv(), { ...claims, sub: "unregistered" }, 1),
  ).rejects.toThrow();
  await expect(
    registerAccessSession(mutationEnv(), { ...claims, iss: "https://other.invalid" }, 1),
  ).rejects.toThrow();
});

it("keeps a logout tombstone and refuses to recreate the same JWT session", async () => {
  const { claims } = await fixture();
  const session = await registerAccessSession(mutationEnv(), claims, 1);
  await revokeAccessSession(mutationEnv(), session.credential_id, 1);
  await revokeAccessSession(mutationEnv(), session.credential_id, 1);
  expect(await readAccessSession(env.DB, session.credential_id, 1)).toBeNull();
  await expect(registerAccessSession(mutationEnv(), claims, 1)).rejects.toThrow();
});

it("revokes content sessions derived by the user across access sessions", async () => {
  const { ids, claims } = await fixture();
  const one = await registerAccessSession(mutationEnv(), claims, 1);
  const two = await registerAccessSession(mutationEnv(), { ...claims, iat: claims.iat - 1 }, 1);
  const now = Date.now();
  const budget = `u:${ids.user}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [budget, ids.user, ids.user, now + 600000],
    },
    ...[one, two].flatMap((session, index) => {
      const target = `${ids.user}-target-${index}`;
      const ticket = `${ids.user}-ticket-${index}`;
      return [
        {
          sql: "INSERT INTO target_sets VALUES(?,?,?,'hash','manifest',3,?,1)",
          values: [target, ids.user, session.credential_id, now + 600000],
        },
        {
          sql: `INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
            VALUES(?,?,?,?,'content',1,?,?)`,
          values: [ticket, session.credential_id, target, budget, now, now + 600000],
        },
        {
          sql: `INSERT INTO content_sessions
            (id,user_id,issued_by_credential_id,target_set_id,budget_id,ticket_id,epoch,issued_at,expires_at)
            VALUES(?,?,?,?,?,?,1,?,?)`,
          values: [
            `${ids.user}-cs-${index}`,
            ids.user,
            session.credential_id,
            target,
            budget,
            ticket,
            now,
            now + 600000,
          ],
        },
      ];
    }),
  ]);
  await revokeAccessSession(mutationEnv(), one.credential_id, 1);
  expect(
    (
      await env.DB.prepare("SELECT revoked_at FROM content_sessions WHERE user_id=?")
        .bind(ids.user)
        .all()
    ).results.every((row) => row.revoked_at !== null),
  ).toBe(true);
  expect(await readAccessSession(env.DB, two.credential_id, 1)).not.toBeNull();
});

it("a job chunk cannot commit after its initiating session logs out", async () => {
  const { ids, claims } = await fixture();
  const session = await registerAccessSession(mutationEnv(), claims, 1);
  await revokeAccessSession(mutationEnv(), session.credential_id, 1);
  await expect(
    atomicBatch(env.DB, [
      { sql: "UPDATE users SET used_bytes=123 WHERE id=?", values: [ids.user] },
      assertLiveAccessCredential(session.credential_id, 1),
    ]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT used_bytes FROM users WHERE id=?")
      .bind(ids.user)
      .first("used_bytes"),
  ).toBe(3);
});

it.each(["disabled", "expired", "epoch"])(
  "rejects a currently %s credential",
  async (condition) => {
    const { ids, claims } = await fixture();
    const session = await registerAccessSession(mutationEnv(), claims, 1);
    if (condition === "disabled") {
      await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(ids.user).run();
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(ids.user).run();
    } else if (condition === "expired") {
      await env.DB.prepare("UPDATE sessions SET expires_at=issued_at+1 WHERE id=?")
        .bind(session.session_id)
        .run();
    } else {
      await env.DB.prepare("UPDATE control SET epoch=2").run();
    }
    expect(await readAccessSession(env.DB, session.credential_id, 1)).toBeNull();
  },
);
