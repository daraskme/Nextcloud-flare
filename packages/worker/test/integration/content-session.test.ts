import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { contentSessionAssertion } from "../../src/auth/contentSession";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("asserts current private content session, ticket, target set and budget in D1", async () => {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  const ids = {
    budget: crypto.randomUUID(),
    target: crypto.randomUUID(),
    content: crypto.randomUUID(),
    ticket: crypto.randomUUID(),
  };
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [ids.budget, f.ids.user, f.ids.user, now + 300000],
    },
    {
      sql: `INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,'hash','target-manifest',3,?,1)`,
      values: [ids.target, f.ids.user, f.ids.credential, now + 300000],
    },
    {
      sql: `INSERT INTO content_sessions(id,user_id,issued_by_credential_id,target_set_id,budget_id,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,?,1,?,?)`,
      values: [
        ids.content,
        f.ids.user,
        f.ids.credential,
        ids.target,
        ids.budget,
        now,
        now + 300000,
      ],
    },
    {
      sql: `INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,'content',1,?,?)`,
      values: [ids.ticket, f.ids.credential, ids.target, ids.budget, now, now + 300000],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const check = () =>
    atomicBatch(env.DB, [contentSessionAssertion(principal, ids.content, ids.ticket, "content")]);
  await check();
  await expect(
    atomicBatch(env.DB, [contentSessionAssertion(principal, ids.content, ids.ticket, "zip")]),
  ).rejects.toThrow();
  await expect(
    atomicBatch(env.DB, [
      contentSessionAssertion(
        { ...principal, credential_id: crypto.randomUUID() },
        ids.content,
        ids.ticket,
        "content",
      ),
    ]),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE target_sets SET expires_at=? WHERE id=?")
    .bind(now - 2000, ids.target)
    .run();
  await expect(check()).rejects.toThrow();
  await env.DB.prepare("UPDATE target_sets SET expires_at=? WHERE id=?")
    .bind(now + 300000, ids.target)
    .run();
  await env.DB.prepare("UPDATE tickets SET cancelled_at=? WHERE id=?").bind(now, ids.ticket).run();
  await expect(check()).rejects.toThrow();
  await env.DB.prepare("UPDATE tickets SET cancelled_at=NULL WHERE id=?").bind(ids.ticket).run();
  await env.DB.prepare("UPDATE content_sessions SET revoked_at=? WHERE id=?")
    .bind(now, ids.content)
    .run();
  await expect(check()).rejects.toThrow();
  await env.DB.prepare("UPDATE content_sessions SET revoked_at=NULL WHERE id=?")
    .bind(ids.content)
    .run();
  await env.DB.prepare("UPDATE budgets SET state='revoked' WHERE id=?").bind(ids.budget).run();
  await expect(check()).rejects.toThrow();
});
