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
  const reservationId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch)
    VALUES(?,?,1,'reserved',?,1)`)
    .bind(reservationId, fixture.ids.user, Date.now() + 60_000)
    .run();
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.nextRecoveryAuditPage(2, 1)).rejects.toThrow(
        /recovery_final_fence_pending/,
      );
    });
    await runInDurableObject(control(), async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ stage: string; pages: number }>(
            "SELECT stage,pages FROM recovery_audit_v7 WHERE singleton=1",
          )
          .one(),
      ).toMatchObject({ stage: "users", pages: 0 });
    });
  } finally {
    await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
      .bind(reservationId)
      .run();
    await env.DB.prepare("DELETE FROM reservations WHERE id=?").bind(reservationId).run();
  }
  expect(await control().nextRecoveryAuditPage(2, 1)).toMatchObject({
    stage: "blobs",
    pages: 1,
    completed: false,
  });
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

it("fails old-epoch create and rename notifications only after their claims drain", async () => {
  const permitId = crypto.randomUUID();
  const opId = crypto.randomUUID();
  const renameOpId = crypto.randomUUID();
  const renameId = crypto.randomUUID();
  const wrongKindId = crypto.randomUUID();
  const pendingId = crypto.randomUUID();
  const sentId = crypto.randomUUID();
  const mismatchedId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,1,'released')",
  )
    .bind(permitId, fixture.ids.space)
    .run();
  await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,
    space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,
    claimed_expires_at,expected_steps,created_at,updated_at)
    VALUES(?,'user',?,?,?,'node.create','committed','digest',1,?,1,1,0,1,1)`)
    .bind(opId, fixture.ids.user, fixture.ids.credential, fixture.ids.space, permitId)
    .run();
  await env.DB.prepare(
    "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
  )
    .bind(opId, fixture.ids.folder)
    .run();
  await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,
    space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,
    claimed_expires_at,expected_steps,created_at,updated_at)
    VALUES(?,'user',?,?,?,'node.rename','committed','digest',1,?,1,1,0,1,1)`)
    .bind(renameOpId, fixture.ids.user, fixture.ids.credential, fixture.ids.space, permitId)
    .run();
  await env.DB.prepare(
    "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
  )
    .bind(renameOpId, fixture.ids.folder)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
    VALUES(?,?,'node.renamed',?,'pending',1,1,1)`)
    .bind(renameId, renameOpId, fixture.ids.folder)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
    VALUES(?,?,'node.created',?,'pending',1,1,1)`)
    .bind(wrongKindId, renameOpId, fixture.ids.folder)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
    VALUES(?,?,'node.created',?,'pending',1,1,1)`)
    .bind(pendingId, opId, fixture.ids.folder)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
    VALUES(?,?,'node.created',?,'pending',1,1,1)`)
    .bind(mismatchedId, opId, fixture.ids.root)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,
    dispatch_token,dispatch_expires_at,claim_token,claim_expires_at,created_at,updated_at)
    VALUES(?,?,'node.created',?,'sent',1,'dispatch',0,'claim',?,1,1)`)
    .bind(sentId, opId, fixture.ids.folder, Date.now() + 60_000)
    .run();
  try {
    await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(/recovery_not_quiesced/);
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.failStaleOutbox(2)).rejects.toThrow(/recovery_not_quiesced/);
    });
    await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?")
      .bind(sentId)
      .run();
    expect(await control().failStaleOutbox(2)).toMatchObject({
      failed: 3,
      audit: { stage: "users", pages: 0 },
    });
    for (const id of [pendingId, sentId, renameId]) {
      expect(
        await env.DB.prepare(
          "SELECT state,dispatch_token,claim_token FROM outbox WHERE outbox_id=?",
        )
          .bind(id)
          .first(),
      ).toMatchObject({ state: "failed", dispatch_token: null, claim_token: null });
    }
    expect(
      await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?")
        .bind(mismatchedId)
        .first("state"),
    ).toBe("pending");
    expect(
      await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?")
        .bind(wrongKindId)
        .first("state"),
    ).toBe("pending");
    await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
      /recovery_final_fence_pending/,
    );
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id=?").bind(mismatchedId).run();
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id=?").bind(wrongKindId).run();
    await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
  } finally {
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id IN (?,?,?,?,?)")
      .bind(pendingId, sentId, mismatchedId, renameId, wrongKindId)
      .run();
    await env.DB.prepare("DELETE FROM operation_steps WHERE op_id IN (?,?)")
      .bind(opId, renameOpId)
      .run();
    await env.DB.prepare("DELETE FROM operations WHERE op_id IN (?,?)")
      .bind(opId, renameOpId)
      .run();
    await env.DB.prepare("DELETE FROM permits WHERE permit_id=?").bind(permitId).run();
  }
});

it("keeps upload reservations out of generic repair even after the upload becomes terminal", async () => {
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
    expect(await control().releaseStaleReservations(2, 1)).toMatchObject({ released: 0 });
    // Terminal metadata alone does not prove that an old PUT left no R2 object.
    await env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(uploadId).run();
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

it("repairs an expired upload through ControlDO and invalidates the recovery audit", async () => {
  const reservationId = crypto.randomUUID();
  const blobId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const attempt = crypto.randomUUID();
  const objectKey = `u/${fixture.ids.user}/b/${blobId}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
      values: [blobId, fixture.ids.user, objectKey],
    },
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',86400001,1)",
      values: [reservationId, fixture.ids.user],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,
        declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,write_attempt_id,write_lease_expires_at)
      VALUES(?,?,?,?,?,?,?,'single','receiving',3,'fixture',1,1,86400001,1,'expired.txt',?,900001)`,
      values: [
        uploadId,
        fixture.ids.user,
        fixture.ids.space,
        fixture.ids.root,
        blobId,
        fixture.ids.credential,
        reservationId,
        attempt,
      ],
    },
  ]);
  await env.BLOBS.put(objectKey, "abc", {
    customMetadata: { upload_id: uploadId, blob_id: blobId, attempt_id: attempt, epoch: "1" },
  });
  try {
    expect(await control().repairExpiredUploads(2, 1)).toMatchObject({
      cleanup: { claimed: 1, queued: 1, r2Calls: 1 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    expect(await control().status()).toMatchObject({ epoch: 2, maintenance: true, gcPaused: true });
    expect(
      await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
        .bind(fixture.ids.user)
        .first("physical_bytes"),
    ).toBe(6);
    await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
    await env.DB.prepare("DELETE FROM gc_candidates WHERE blob_id=?").bind(blobId).run();
    await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
      /recovery_final_fence_pending/,
    );
  } finally {
    await env.BLOBS.delete(objectKey);
    await atomicBatch(env.DB, [
      { sql: "UPDATE blobs SET state='deleted' WHERE id=?", values: [blobId] },
      {
        sql: "UPDATE blob_storage SET removed_at=MAX(observed_at,strftime('%s','now')*1000) WHERE blob_id=? AND removed_at IS NULL",
        values: [blobId],
      },
      { sql: "DELETE FROM uploads WHERE id=?", values: [uploadId] },
      { sql: "DELETE FROM gc_candidates WHERE blob_id=?", values: [blobId] },
      { sql: "DELETE FROM blob_storage WHERE blob_id=?", values: [blobId] },
      { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [reservationId] },
      { sql: "DELETE FROM reservations WHERE id=?", values: [reservationId] },
      { sql: "DELETE FROM blobs WHERE id=?", values: [blobId] },
    ]);
  }
});

it.each([false, true])(
  "repairs old-epoch multipart parts without accepting an unproven GC handoff (legacy=%s)",
  async (legacy) => {
    const reservationId = crypto.randomUUID();
    const blobId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const attempt = crypto.randomUUID();
    const objectKey = `u/${fixture.ids.user}/b/${blobId}`;
    const multipart = await env.BLOBS.createMultipartUpload(objectKey, {
      customMetadata: { upload_id: uploadId, blob_id: blobId, attempt_id: attempt, epoch: "1" },
    });
    await multipart.uploadPart(1, new TextEncoder().encode("abc"));
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
        values: [blobId, fixture.ids.user, objectKey],
      },
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',86400001,1)",
        values: [reservationId, fixture.ids.user],
      },
      {
        sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,
        declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,write_attempt_id,write_lease_expires_at,r2_upload_id,part_bytes,part_count)
      VALUES(?,?,?,?,?,?,?,'multipart','uploading',3,'fixture',1,1,518400001,1,'expired.bin',?,900001,?,67108864,1)`,
        values: [
          uploadId,
          fixture.ids.user,
          fixture.ids.space,
          fixture.ids.root,
          blobId,
          fixture.ids.credential,
          reservationId,
          attempt,
          multipart.uploadId,
        ],
      },
    ]);
    try {
      if (legacy) {
        await atomicBatch(env.DB, [
          {
            sql: "UPDATE uploads SET state='failed',accept_parts=0,cleanup_pending=1 WHERE id=?",
            values: [uploadId],
          },
          { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [reservationId] },
          {
            sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'legacy',1)",
            values: [blobId],
          },
          {
            sql: "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',1)",
            values: [blobId],
          },
        ]);
        await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow(
          /recovery_final_fence_pending/,
        );
        await env.DB.prepare("DELETE FROM gc_candidates WHERE blob_id=?").bind(blobId).run();
      }
      expect(await control().repairStoppedMultipartUploads(2, 1)).toMatchObject({
        cleanup: { claimed: 1, absent: 1, r2Calls: 2 },
        audit: { stage: "users", pages: 0, completed: false },
      });
      expect(await control().status()).toMatchObject({
        epoch: 2,
        maintenance: true,
        gcPaused: true,
      });
      expect(
        await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
          .bind(fixture.ids.user)
          .first("physical_bytes"),
      ).toBe(3);
      await expect(inspectRecoveryFinalFence(env.DB, 2)).resolves.toBeUndefined();
      expect(
        await env.DB.prepare(
          "SELECT state,cleanup_pending,multipart_cleanup_closed FROM uploads WHERE id=?",
        )
          .bind(uploadId)
          .first(),
      ).toMatchObject({ state: "failed", cleanup_pending: 0, multipart_cleanup_closed: "aborted" });
    } finally {
      await env.BLOBS.delete(objectKey);
      await atomicBatch(env.DB, [
        { sql: "UPDATE blobs SET state='deleted' WHERE id=?", values: [blobId] },
        {
          sql: "UPDATE blob_storage SET removed_at=MAX(observed_at,strftime('%s','now')*1000) WHERE blob_id=? AND removed_at IS NULL",
          values: [blobId],
        },
        { sql: "DELETE FROM uploads WHERE id=?", values: [uploadId] },
        { sql: "DELETE FROM gc_candidates WHERE blob_id=?", values: [blobId] },
        { sql: "DELETE FROM blob_storage WHERE blob_id=?", values: [blobId] },
        { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [reservationId] },
        { sql: "DELETE FROM reservations WHERE id=?", values: [reservationId] },
        { sql: "DELETE FROM blobs WHERE id=?", values: [blobId] },
      ]);
    }
  },
);

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
