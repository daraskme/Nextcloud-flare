import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence, inspectRecoveryPage } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
const known = `u/${f.ids.user}/b/${f.ids.blob}`;
const unknown = `u/${f.ids.user}/b/unknown`;
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await control().recover()).toMatchObject({ epoch: 2 });
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  const object = (await env.BLOBS.put(known, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.ids.blob, object.etag)
    .run();
  await env.BLOBS.put(unknown, "untracked");
});

it("turns an untracked completed object into an accounted quarantine without reopening admission", async () => {
  await expect(
    inspectRecoveryPage(env.DB, env.BLOBS, 2, { stage: "r2", afterId: "" }, 20),
  ).rejects.toThrow("recovery_untracked_r2_object");
  expect(await control().inventoryOrphanObjects(2, 20)).toMatchObject({
    inventory: { observed: 1, completed: true },
    audit: { stage: "users", pages: 0 },
  });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(12);
  let progress = await control().beginRecoveryAudit(2);
  for (let i = 0; i < 30 && !progress.completed; i++)
    progress = await control().nextRecoveryAuditPage(2, 20);
  expect(progress.completed).toBe(true);
  expect(await control().status()).toMatchObject({ epoch: 2, maintenance: true, gcPaused: true });
  expect(await env.BLOBS.head(unknown)).not.toBeNull();
});

it("detects a changed R2 generation and restarts the audit after rescanning", async () => {
  await env.BLOBS.put(unknown, "replaced");
  await expect(
    inspectRecoveryPage(env.DB, env.BLOBS, 2, { stage: "r2", afterId: "" }, 20),
  ).rejects.toThrow("recovery_untracked_r2_object");
  expect(await control().inventoryOrphanObjects(2, 20)).toMatchObject({
    inventory: { observed: 1 },
    audit: { stage: "users", pages: 0 },
  });
  await expect(
    inspectRecoveryPage(env.DB, env.BLOBS, 2, { stage: "r2", afterId: "" }, 20),
  ).resolves.toMatchObject({ next: { stage: "outbox" } });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(11);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.inventoryOrphanObjects(1, 20)).rejects.toThrow();
  });
});

it("keeps unresolved orphan claims and inventory leases out of the final recovery fence", async () => {
  await env.DB.prepare(
    "UPDATE orphan_objects SET state='deleting',claim_token='claim',claim_expires_at=? WHERE r2_key=?",
  )
    .bind(Date.now() + 60000, unknown)
    .run();
  await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
    "recovery_final_fence_pending",
  );
  await env.BLOBS.delete(unknown);
  await env.DB.prepare(
    "UPDATE orphan_objects SET state='deleted',removed_at=MAX(last_seen_at,strftime('%s','now')*1000),claim_token=NULL,claim_expires_at=NULL WHERE r2_key=?",
  )
    .bind(unknown)
    .run();
  await env.DB.prepare("UPDATE r2_inventory_scan SET lease_token='scan',lease_expires_at=?")
    .bind(Date.now() + 60000)
    .run();
  await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
    "recovery_final_fence_pending",
  );
  await env.DB.prepare("UPDATE r2_inventory_scan SET lease_token=NULL,lease_expires_at=NULL").run();
  await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
});
