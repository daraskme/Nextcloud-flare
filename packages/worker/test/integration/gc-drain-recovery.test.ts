import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { ORPHAN_GRACE_MS } from "../../src/jobs/orphanInventory";
import { foundationFixture } from "../fixtures/foundation";

it("completes the recovery audit after draining interrupted blob and orphan GC without reopening admission", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await control.recover();
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = (await env.BLOBS.put(key, "abc"))!;
  const orphanKey = `u/${f.ids.user}/b/orphan`;
  const orphan = (await env.BLOBS.put(orphanKey, "xyz"))!;
  const seen = Date.now() - ORPHAN_GRACE_MS - 1000;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [f.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
    { sql: "UPDATE blobs SET state='deleting' WHERE id=?", values: [f.ids.blob] },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at) VALUES(?,'deleting',0,?,0)",
      values: [f.ids.blob, crypto.randomUUID()],
    },
    {
      sql: `INSERT INTO orphan_objects(r2_key,owner_key,blob_key,owner_id,bytes,r2_etag,r2_version,
      uploaded_at,first_seen_at,last_seen_at,epoch,state,claim_token,claim_expires_at)
      VALUES(?,?,'orphan',?,3,?,?,?,?,?,1,'deleting',?,0)`,
      values: [
        orphanKey,
        f.ids.user,
        f.ids.user,
        orphan.etag,
        orphan.version,
        orphan.uploaded.getTime(),
        seen,
        seen,
        crypto.randomUUID(),
      ],
    },
  ]);
  await runInDurableObject(control, async (instance) => {
    await instance.beginRecoveryAudit(2);
    await expect(instance.nextRecoveryAuditPage(2, 20)).rejects.toThrow("recovery_not_quiesced");
    expect(await instance.drainBlobGarbageCollection(2)).toMatchObject({ cleanup: { deleted: 1 } });
    expect(await instance.drainOrphanGarbageCollection(2)).toMatchObject({
      cleanup: { deleted: 1 },
    });
    let complete = false;
    for (let i = 0; i < 20 && !complete; i++) {
      complete = (await instance.nextRecoveryAuditPage(2, 20)).completed;
    }
    expect(complete).toBe(true);
    expect(await instance.status()).toMatchObject({ epoch: 2, maintenance: true, gcPaused: true });
  });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(0);
  expect(await env.BLOBS.head(key)).toBeNull();
  expect(await env.BLOBS.head(orphanKey)).toBeNull();
});
