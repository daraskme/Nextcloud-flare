import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence, inspectRecoverySearchFts } from "../../src/do/recoveryAudit";
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
    stage: "r2",
    pages: 2,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "outbox",
    pages: 3,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "shares",
    pages: 4,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "credentials",
    pages: 5,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "credential_sources",
    pages: 6,
    completed: false,
  });
  for (let pages = 7; pages <= 9; pages++) {
    expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
      stage: "credential_sources",
      pages,
      completed: false,
    });
  }
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "fts",
    pages: 10,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "fence",
    pages: 11,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "complete",
    pages: 12,
    completed: true,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({ pages: 12, completed: true });
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
    stage: "r2",
    pages: 2,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "outbox",
    pages: 3,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "shares",
    pages: 4,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "credentials",
    pages: 5,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "credential_sources",
    pages: 6,
    completed: false,
  });
  for (let pages = 7; pages <= 9; pages++) {
    expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
      stage: "credential_sources",
      pages,
      completed: false,
    });
  }
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "fts",
    pages: 10,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "fence",
    pages: 11,
    completed: false,
  });
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "complete",
    pages: 12,
    completed: true,
  });
});

it("persists an R2 list cursor and retries an untracked object after eviction", async () => {
  const unknown = `zzzz-untracked-${crypto.randomUUID()}`;
  await env.BLOBS.put(unknown, "extra");
  try {
    await control().beginRecoveryAudit(2);
    expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({ stage: "blobs" });
    expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({ stage: "r2" });
    const listed = await control().nextRecoveryAuditPage(2, 1);
    expect(listed).toMatchObject({ stage: "r2", pages: 3 });
    expect(listed.afterId).not.toBe("");
    await evictDurableObject(control());
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.nextRecoveryAuditPage(2, 1)).rejects.toThrow(
        /recovery_untracked_r2_object/,
      );
    });
    await env.BLOBS.delete(unknown);
    expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
      stage: "outbox",
      pages: 4,
    });
  } finally {
    await env.BLOBS.delete(unknown);
  }
});

it("releases a stale reservation under maintenance and restarts the audit", async () => {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch)
    VALUES(?,?,7,'reserved',?,1)`)
    .bind(id, fixture.ids.user, Date.now() + 60000)
    .run();
  try {
    await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
      /recovery_final_fence_pending/,
    );
    expect(await control().releaseStaleReservations(2, 1)).toMatchObject({
      released: 1,
      audit: { stage: "users", pages: 0 },
    });
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?").bind(id).first("state"),
    ).toBe("released");
    await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
  } finally {
    await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM reservations WHERE id=?").bind(id).run();
  }
});

it("holds an old reservation until its linked upload becomes terminal", async () => {
  const reservationId = crypto.randomUUID();
  const blobId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
    VALUES(?,?,?,1,'etag','staging',1)`)
    .bind(blobId, fixture.ids.user, `u/${fixture.ids.user}/b/${blobId}`)
    .run();
  await env.DB.prepare(`INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch)
    VALUES(?,?,1,'reserved',?,1)`)
    .bind(reservationId, fixture.ids.user, Date.now() + 60000)
    .run();
  await env.DB.prepare(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,
    reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
    VALUES(?,?,?,?,?,?,?,'single','created',1,'cap',1,1,2,1)`)
    .bind(
      uploadId,
      fixture.ids.user,
      fixture.ids.space,
      fixture.ids.root,
      blobId,
      fixture.ids.credential,
      reservationId,
    )
    .run();
  try {
    expect(await control().releaseStaleReservations(2, 1)).toMatchObject({ released: 0 });
    await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
      /recovery_final_fence_pending/,
    );
    await env.DB.prepare("UPDATE uploads SET state='expired' WHERE id=?").bind(uploadId).run();
    expect(await control().releaseStaleReservations(2, 1)).toMatchObject({ released: 1 });
    await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
  } finally {
    await env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(uploadId).run();
    await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
      .bind(reservationId)
      .run();
    await env.DB.prepare("DELETE FROM reservations WHERE id=?").bind(reservationId).run();
    await env.DB.prepare("DELETE FROM blobs WHERE id=?").bind(blobId).run();
  }
});

it("rebuilds restored FTS under the recovery fence and restarts the audit", async () => {
  await env.DB.prepare(`INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
    VALUES(?,?,'recoveryneedle','re co','v1',1)`)
    .bind(fixture.ids.folder, fixture.ids.space)
    .run();
  await expect(inspectRecoverySearchFts(env.DB, 2)).rejects.toThrow();
  expect(await control().beginRecoveryAudit(2)).toMatchObject({ stage: "users", pages: 0 });
  for (let i = 0; i < 10; i++) await control().nextRecoveryAuditPage(2, 1);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.nextRecoveryAuditPage(2, 1)).rejects.toThrow();
  });
  expect(await control().rebuildRecoveryFts(2)).toMatchObject({
    epoch: 2,
    stage: "users",
    pages: 0,
    completed: false,
  });
  await expect(inspectRecoverySearchFts(env.DB, 2)).resolves.toBeUndefined();
  expect(
    (
      await env.DB.prepare(
        "SELECT rowid FROM search_fts WHERE search_fts MATCH 'recoveryneedle'",
      ).all()
    ).results,
  ).toHaveLength(1);
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
