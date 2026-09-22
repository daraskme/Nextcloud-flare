import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { contentSessionAssertion } from "../../src/auth/contentSession";
import { atomicBatch } from "../../src/db/primary";
import { prepareContentBlobRead } from "../../src/services/blobRead";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  const ref = `target-sets/${ids.target}`;
  const manifest = JSON.stringify({
    v: 1,
    targets: [
      { spaceId: f.ids.space, nodeId: f.ids.file, blobId: f.ids.blob, purpose: "content", size: 3 },
    ],
  });
  const hash = await sha256(manifest);
  await env.BLOBS.put(ref, manifest);
  const blobKey = `u/${f.ids.user}/b/${f.ids.blob}`;
  const stored = await env.BLOBS.put(blobKey, "abc");
  if (!stored) throw new Error("fixture_r2_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.ids.blob, stored.etag)
    .run();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [ids.budget, f.ids.user, f.ids.user, now + 300000],
    },
    {
      sql: `INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,?,?,3,?,1)`,
      values: [ids.target, f.ids.user, f.ids.credential, hash, ref, now + 300000],
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
  const grant = { sessionId: ids.content, ticketId: ids.ticket, purpose: "content" as const };
  const planned = await prepareContentBlobRead(
    env.DB,
    env.BLOBS,
    principal,
    f.ids.space,
    f.ids.file,
    grant,
  );
  expect(planned.budgetId).toBe(ids.budget);
  expect(planned.blob).toMatchObject({ key: blobKey, size: 3 });
  await env.BLOBS.put(ref, "{}");
  await expect(
    prepareContentBlobRead(env.DB, env.BLOBS, principal, f.ids.space, f.ids.file, grant),
  ).rejects.toThrow(/invalid_target_manifest/);
  await env.BLOBS.put(ref, manifest);
  const otherManifest = JSON.stringify({
    v: 1,
    targets: [
      {
        spaceId: f.ids.space,
        nodeId: crypto.randomUUID(),
        blobId: f.ids.blob,
        purpose: "content",
        size: 3,
      },
    ],
  });
  await env.BLOBS.put(ref, otherManifest);
  await env.DB.prepare("UPDATE target_sets SET manifest_hash=? WHERE id=?")
    .bind(await sha256(otherManifest), ids.target)
    .run();
  await expect(
    prepareContentBlobRead(env.DB, env.BLOBS, principal, f.ids.space, f.ids.file, grant),
  ).rejects.toThrow(/content_not_available/);
  await env.BLOBS.put(ref, manifest);
  await env.DB.prepare("UPDATE target_sets SET manifest_hash=? WHERE id=?")
    .bind(hash, ids.target)
    .run();
  const shortManifest = JSON.stringify({
    v: 1,
    targets: [
      { spaceId: f.ids.space, nodeId: f.ids.file, blobId: f.ids.blob, purpose: "content", size: 2 },
    ],
  });
  await env.BLOBS.put(ref, shortManifest);
  await env.DB.prepare("UPDATE target_sets SET manifest_hash=?,total_bytes=2 WHERE id=?")
    .bind(await sha256(shortManifest), ids.target)
    .run();
  await expect(
    prepareContentBlobRead(env.DB, env.BLOBS, principal, f.ids.space, f.ids.file, grant),
  ).rejects.toThrow(/content_not_available/);
  await env.BLOBS.put(ref, manifest);
  await env.DB.prepare("UPDATE target_sets SET manifest_hash=?,total_bytes=3 WHERE id=?")
    .bind(hash, ids.target)
    .run();
  const raced = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.prepare("UPDATE tickets SET cancelled_at=? WHERE id=?")
        .bind(now, ids.ticket)
        .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  await expect(
    prepareContentBlobRead(raced, env.BLOBS, principal, f.ids.space, f.ids.file, grant),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE tickets SET cancelled_at=NULL WHERE id=?").bind(ids.ticket).run();
  const changedManifest = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.prepare("UPDATE target_sets SET manifest_hash=? WHERE id=?")
        .bind("0".repeat(64), ids.target)
        .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  await expect(
    prepareContentBlobRead(changedManifest, env.BLOBS, principal, f.ids.space, f.ids.file, grant),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE target_sets SET manifest_hash=? WHERE id=?")
    .bind(hash, ids.target)
    .run();
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
  await env.BLOBS.delete([ref, blobKey]);
});
