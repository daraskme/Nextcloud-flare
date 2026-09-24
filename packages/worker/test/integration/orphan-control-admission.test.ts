import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import {
  drainStoppedOrphanGarbageCollection,
  scanOrphanObjects,
} from "../../src/jobs/orphanInventory";
import { foundationFixture } from "../fixtures/foundation";
import { orphanBucket, orphanFixture, trackOrphan } from "../fixtures/orphanInventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2,
  space = "";
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  space = f.ids.space;
  await atomicBatch(env.DB, f.statements);
  const object = (await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [f.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
  ]);
});
beforeEach(async () => {
  await control().quiesce(epoch);
  await env.DB.prepare("UPDATE orphan_objects SET next_check_at=9999999999999").run();
  await env.DB.prepare(
    "UPDATE r2_inventory_scan SET epoch=?,cursor='',lease_token=NULL,lease_expires_at=NULL,next_scan_at=0,last_token=NULL,pages=0",
  )
    .bind(epoch)
    .run();
});
async function fill(maintenance: 0 | 1) {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        maintenance ? (i % 2 ? "global:orphan.scan-page:" : "system:upload.observe:") + id : id,
        maintenance && i % 2 ? null : space,
        epoch,
        maintenance,
        maintenance,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
  return ids;
}
async function waiting(prefix: string) {
  await expect
    .poll(
      () =>
        env.DB.prepare(
          "SELECT COUNT(*) n FROM mutation_admissions WHERE state='waiting' AND substr(permit_id,1,length(?))=?",
        )
          .bind(prefix, prefix)
          .first("n"),
      { timeout: 4000, interval: 25 },
    )
    .toBe(1);
}
async function resume() {
  await control().beginRecoveryAudit(epoch);
  let complete = false;
  for (let i = 0; i < 30; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      complete = true;
      break;
    }
  expect(complete).toBe(true);
  await control().resumeAdmission(epoch);
}
it("normal orphan work waits behind namespace capacity and cannot dispatch before its grant", async () => {
  await resume();
  const f = await orphanFixture();
  let lists = 0;
  const bucket = orphanBucket({
    list: async (options) => {
      lists++;
      return f.bucket.list(options);
    },
  });
  const ids = await fill(0);
  const pending = scanOrphanObjects(env, bucket, epoch, { limit: 1 });
  try {
    await waiting("global:orphan.scan-claim:");
    expect(lists).toBe(0);
    await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
      .bind(ids[0]!)
      .run();
    expect(await pending).toMatchObject({ observed: 1, completed: true });
    expect(lists).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM mutation_admissions WHERE permit_id LIKE 'global:orphan.%' AND system=1 AND space_id IS NULL AND maintenance=0 AND committed_at IS NOT NULL",
      ).first("n"),
    ).toBe(6);
  } finally {
    await control().quiesce(epoch);
    await pending.catch(() => {});
  }
});
const kinds = [
  "scan-claim",
  "scan-call",
  "scan-observe",
  "scan-page",
  "scan-release",
  "gc-claim",
  "gc-call",
  "gc-observe",
  "gc-finalize",
  "gc-error",
] as const;
it.each(kinds)("stopped native %s shares the full coordinator without self RPC", async (kind) => {
  const f = await orphanFixture(),
    scan = kind.startsWith("scan-");
  if (!scan) {
    await trackOrphan(f);
    await env.DB.prepare("UPDATE orphan_objects SET state='deleting' WHERE r2_key=?")
      .bind(f.key)
      .run();
  }
  if (kind === "gc-observe") await env.BLOBS.put(f.key, "newer");
  const bucket = orphanBucket({
    list: f.bucket.list.bind(f.bucket),
    head: async (key) => {
      if (kind === "gc-error" || kind === "scan-release") throw new Error("head_failed");
      return env.BLOBS.head(key);
    },
  });
  let ids: string[] = [],
    permit = "";
  const prefix = "global:orphan." + kind + ":";
  const pending = runInDurableObject(control(), async (_, state) => {
    const instance = new ControlDO(state, { ...env, BLOBS: bucket });
    const native = instance.acquireGlobalMutation.bind(instance);
    instance.acquireGlobalMutation = async (r) => {
      if (!permit && r.permitId.startsWith(prefix)) {
        permit = r.permitId;
        ids = await fill(1);
      }
      return native(r);
    };
    try {
      return await (scan
        ? instance.inventoryOrphanObjects(epoch, 1)
        : instance.drainOrphanGarbageCollection(epoch, 1)
      ).catch((e) => e as Error);
    } finally {
      instance.acquireGlobalMutation = native;
    }
  });
  try {
    await waiting(prefix);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM mutation_admissions WHERE state='active'").first(
        "n",
      ),
    ).toBe(32);
    await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
      .bind(ids[0]!)
      .run();
    const result = await pending;
    if (kind === "scan-release") expect(result).toBeInstanceOf(Error);
    else if (scan) expect(result).toMatchObject({ inventory: { observed: 1, completed: true } });
    else
      expect(result).toMatchObject({
        cleanup:
          kind === "gc-observe"
            ? { changed: 1 }
            : kind === "gc-error"
              ? { retried: 1 }
              : { deleted: 1 },
      });
    expect(
      await env.DB.prepare(
        "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
      )
        .bind(permit)
        .first(),
    ).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      space_id: null,
      system: 1,
      maintenance: 1,
    });
    expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
  } finally {
    await env.DB.prepare(
      "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
    ).run();
    await pending;
  }
});
it("lost deletion dispatch ACK survives coordinator eviction without releasing or replaying the claim", async () => {
  const f = await orphanFixture();
  await trackOrphan(f);
  await env.DB.prepare("UPDATE orphan_objects SET state='deleting' WHERE r2_key=?")
    .bind(f.key)
    .run();
  let heads = 0,
    deletes = 0;
  const bucket = orphanBucket({
    head: async (key) => {
      heads++;
      return env.BLOBS.head(key);
    },
    delete: async (key) => {
      deletes++;
      await env.BLOBS.delete(key);
    },
  });
  const fault = systemMutationFault("global:orphan.gc-call:", "reads", 2);
  expect(
    await drainStoppedOrphanGarbageCollection({ ...env, DB: fault.db }, bucket, epoch, {
      limit: 1,
    }),
  ).toMatchObject({ retried: 1, r2Calls: 1 });
  expect(fault.fired()).toBe(true);
  expect(fault.reads()).toBe(0);
  expect({ heads, deletes }).toEqual({ heads: 1, deletes: 0 });
  await evictDurableObject(control());
  expect(await control().drainOrphanGarbageCollection(epoch, 1)).toMatchObject({
    cleanup: { claimed: 0 },
  });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(3);
  await env.DB.prepare(
    "UPDATE orphan_objects SET claim_expires_at=1,next_check_at=0 WHERE r2_key=?",
  )
    .bind(f.key)
    .run();
  expect(await control().drainOrphanGarbageCollection(epoch, 1)).toMatchObject({
    cleanup: { deleted: 1 },
  });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(0);
});
