import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { foundationFixture } from "../fixtures/foundation";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
const key = `u/${fixture.ids.user}/b/${fixture.ids.blob}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect((await control().recover()).epoch).toBe(2);
  await atomicBatch(env.DB, fixture.statements);
  await env.DB.prepare(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss=?,bootstrap_sub=?
    WHERE singleton=1`)
    .bind("https://access.invalid", fixture.ids.user)
    .run();
  const object = await env.BLOBS.put(key, "abc");
  if (!object) throw new Error("fixture_r2_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(fixture.ids.blob, object.etag)
    .run();
});

it("persists page progress across DO eviction and treats completion as diagnostic", async () => {
  expect(await control().beginRecoveryAudit(2)).toEqual({
    epoch: 2,
    stage: "users",
    afterId: "",
    pages: 0,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "blobs",
    pages: 1,
    completed: false,
  });
  await evictDurableObject(control());
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "outbox",
    pages: 2,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "complete",
    pages: 3,
    completed: true,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({ pages: 3, completed: true });
  expect(await control().status()).toEqual({ epoch: 2, maintenance: true, gcPaused: true });
});

it("keeps a failed page pending so repair can resume at the same cursor", async () => {
  expect(await control().beginRecoveryAudit(2)).toMatchObject({ stage: "users", pages: 0 });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({ stage: "blobs", pages: 1 });
  await env.BLOBS.delete(key);
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.nextRecoveryAuditPage(2, 1)).rejects.toThrow(/recovery_r2_mismatch/);
    });
  } finally {
    await env.BLOBS.put(key, "abc");
  }
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "outbox",
    pages: 2,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "complete",
    pages: 3,
    completed: true,
  });
});

it("does not reuse an audit from an old epoch", async () => {
  expect((await control().bumpEpoch(2, "operator")).epoch).toBe(3);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.nextRecoveryAuditPage(2)).rejects.toThrow(
      /recovery_audit_epoch_conflict/,
    );
  });
  expect(await control().beginRecoveryAudit(3)).toMatchObject({ stage: "users", pages: 0 });
});
