import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { cancelCopyJob, cleanupStoppedCopyJob } from "../../src/jobs/copyLifecycle";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { reconcileCopyObject } from "../../src/jobs/copyReconcile";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const MiB = 1024 * 1024;
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearEndedR2TestWrites();
});
function failStatement(prefix: string) {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.startsWith(prefix)
              ? "INSERT INTO _assert(v) SELECT 1 WHERE ? IS NOT NULL" +
                  " OR ? IS NOT NULL".repeat((sql.match(/\?/g)?.length ?? 1) - 1)
              : sql,
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function fixture(mode: "single" | "empty" | "multipart" = "single") {
  const f = await copyJobFixture(
    mode === "empty",
    mode === "multipart" ? new Uint8Array(9 * MiB) : undefined,
  );
  const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  if (mode === "multipart") {
    expect(await copyNextBlob(mutationEnv(), claim, 8 * MiB)).toBe("initialized");
    for (let n = 0; n < 2; n++)
      expect(await copyNextBlob(mutationEnv(), claim, 8 * MiB)).toBe("part");
  }
  const db = failStatement("INSERT INTO blob_storage");
  await expect(copyNextBlob(mutationEnv(db, db), claim, 8 * MiB)).rejects.toThrow();
  const id = f.job.id + "_b00001",
    key = `u/${f.target.ids.user}/b/${id}`;
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  const app = (db = env.DB) => ({ ...mutationEnv(db, db), BLOBS: { head } as unknown as R2Bucket });
  const run = (a = app()) => reconcileCopyObject(a, f.job.id, f.source.ids.blob);
  const size = mode === "multipart" ? 9 * MiB : mode === "empty" ? 0 : 3;
  const ledger = () => auditOwnerLedger(env.DB, f.target.ids.user);
  const checkpoint = () =>
    env.DB.prepare("SELECT checkpoint FROM bulk_jobs WHERE id=?")
      .bind(f.job.id)
      .first("checkpoint");
  expect(
    await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE r2_key=? AND kind=?")
      .bind(key, mode === "multipart" ? "copy.multipart.complete" : "copy.put")
      .first("state"),
  ).toBe("succeeded");
  expect(await ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: size });
  return { ...f, claim, id, key, head, app, run, size, ledger, checkpoint };
}
it.each(["single", "empty", "multipart"] as const)(
  "recovers %s facts once and resumes without resending writes",
  async (mode) => {
    const f = await fixture(mode),
      checkpoint = await f.checkpoint();
    expect(await f.run()).toBe("stored");
    expect(await f.run()).toBe("stored");
    expect(f.head).toHaveBeenCalledExactlyOnceWith(f.key);
    expect(await f.checkpoint()).toBe(checkpoint);
    expect(await f.ledger()).toMatchObject({
      physical_bytes: f.size,
      reserved_bytes: f.size,
      used_bytes: 3,
      incorrect_refs: 0,
    });
    expect(
      await env.DB.prepare("SELECT state,sha256_verified FROM blobs WHERE id=?").bind(f.id).first(),
    ).toMatchObject({
      state: "staging",
      sha256_verified: mode === "multipart" ? null : expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    const next = await claimCopyJob(mutationEnv(), f.job.outboxId);
    expect(await copyNextBlob(f.app(), next)).toBe("stored");
    expect(await copyNextBlob(f.app(), next)).toBe("ready");
  },
);
it.each(["single", "multipart"] as const)(
  "records %s after revocation and stop, retaining physical bytes for GC",
  async (mode) => {
    const f = await fixture(mode);
    await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
    await f.revoke();
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.target.ids.user).run();
    await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
    expect(await f.run()).toBe("stored");
    expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
      settled: 1,
      remaining: 0,
    });
    expect(await f.ledger()).toMatchObject({ physical_bytes: f.size, reserved_bytes: 0 });
    expect(
      await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(f.id).first("state"),
    ).toBe("orphan");
    expect(
      await env.DB.prepare("SELECT not_before FROM gc_candidates WHERE blob_id=?")
        .bind(f.id)
        .first<number>("not_before"),
    ).toBeGreaterThan(Date.now() + 34 * 86400000);
    expect(await env.BLOBS.head(f.key)).not.toBeNull();
  },
);
it.each(["absent", "error", "key", "size", "etag", "checksum", "missing-checksum"])(
  "keeps a single copy held on %s HEAD",
  async (fault) => {
    const f = await fixture(),
      object = await env.BLOBS.head(f.key);
    f.head.mockImplementation(async () => {
      if (fault === "absent") return null;
      if (fault === "error") throw Error("head_failed");
      return {
        ...object!,
        ...(fault === "key"
          ? { key: "other" }
          : fault === "size"
            ? { size: 4 }
            : fault === "etag"
              ? { etag: "" }
              : { checksums: { sha256: fault === "checksum" ? new ArrayBuffer(32) : undefined } }),
      } as R2Object;
    });
    expect(await f.run()).toBe("held");
    expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: 3 });
  },
);
it.each(["copy_job", "copy_blob", "copy_attempt", "missing"])(
  "requires exact multipart identity (%s)",
  async (fault) => {
    const f = await fixture("multipart"),
      object = await env.BLOBS.head(f.key);
    f.head.mockResolvedValue({
      ...object!,
      customMetadata:
        fault === "missing" ? undefined : { ...object!.customMetadata, [fault]: "different" },
    } as R2Object);
    expect(await f.run()).toBe("held");
    expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: f.size });
  },
);
it("does not infer native completion from an existing object after a lost native reply", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const a = {
    ...mutationEnv(),
    BLOBS: {
      get: env.BLOBS.get.bind(env.BLOBS),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        await env.BLOBS.put(...args);
        throw Error("lost_native_reply");
      },
    } as unknown as R2Bucket,
  };
  await expect(copyNextBlob(a, claim)).rejects.toThrow();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  expect(
    await reconcileCopyObject(
      { ...mutationEnv(), BLOBS: { head } as unknown as R2Bucket },
      f.job.id,
      f.source.ids.blob,
    ),
  ).toBe("held");
  expect(head).not.toHaveBeenCalled();
  expect(await env.BLOBS.head(`u/${f.target.ids.user}/b/${f.job.id}_b00001`)).not.toBeNull();
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    physical_bytes: 0,
    reserved_bytes: 3,
  });
});
it("never treats missing dispatch history as completion", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
    (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
    async () => {
      throw Error("lost_prepare");
    },
    true,
  );
  await expect(copyNextBlob(mutationEnv(db, db), claim)).rejects.toThrow();
  const head = vi.fn();
  expect(
    await reconcileCopyObject(
      { ...mutationEnv(), BLOBS: { head } as unknown as R2Bucket },
      f.job.id,
      f.source.ids.blob,
    ),
  ).toBe("held");
  expect(head).not.toHaveBeenCalled();
});
it("does not HEAD after losing the read admission ACK", async () => {
  const f = await fixture();
  const db = injectBatch(
    (s) =>
      s.includes("FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id") &&
      s.includes("w.id=?"),
    async () => {
      throw Error("lost_read_ack");
    },
    true,
  );
  await expect(f.run(f.app(db))).rejects.toThrow("lost_read_ack");
  expect(f.head).not.toHaveBeenCalled();
  expect(await f.run()).toBe("stored");
});
it.each(["epoch", "maintenance", "backup"])(
  "rechecks %s after HEAD before recording facts",
  async (change) => {
    const f = await fixture();
    f.head.mockImplementation(async (key) => {
      const object = await env.BLOBS.head(key);
      if (change === "epoch")
        await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
      if (change === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
      if (change === "backup") {
        const token = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'pending',1,?)",
        )
          .bind(crypto.randomUUID(), token)
          .run();
        await env.DB.prepare("UPDATE control SET backup_token=?").bind(token).run();
      }
      return object;
    });
    try {
      await expect(f.run()).rejects.toThrow();
    } finally {
      await env.DB.prepare("UPDATE control SET backup_token=NULL").run();
    }
    expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: 3 });
  },
);
it.each(["single", "multipart"] as const)(
  "rolls back %s physical accounting if the final observation fails",
  async (mode) => {
    const f = await fixture(mode);
    const db = failStatement("UPDATE copy_job_blobs SET transfer_state='stored'");
    await expect(f.run(f.app(db))).rejects.toThrow();
    expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: f.size });
    expect(await f.run()).toBe("stored");
  },
);
it("recovers a lost commit ACK without double accounting", async () => {
  const f = await fixture();
  const db = injectBatch(
    (s) => s.startsWith("INSERT INTO blob_storage"),
    async () => {
      throw Error("lost_observation_ack");
    },
    true,
  );
  expect(await f.run(f.app(db))).toBe("stored");
  expect(await f.run()).toBe("stored");
  expect(await f.ledger()).toMatchObject({ physical_bytes: 3, reserved_bytes: 3 });
});
it("allows concurrent matching observations without double accounting", async () => {
  const f = await fixture();
  expect(await Promise.all([f.run(), f.run()])).toEqual(["stored", "stored"]);
  expect(await f.ledger()).toMatchObject({ physical_bytes: 3, reserved_bytes: 3 });
});
it("discards a HEAD response that arrives after the invocation deadline", async () => {
  const f = await fixture();
  const now = Date.now();
  f.head.mockImplementation(async (key) => {
    const object = await env.BLOBS.head(key);
    vi.spyOn(Date, "now").mockReturnValue(now + 26000);
    return object;
  });
  expect(await f.run()).toBe("held");
  expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: 3 });
});
it("times out a pending HEAD and ignores its late result until a fresh reconciliation", async () => {
  const f = await fixture(),
    object = await env.BLOBS.head(f.key);
  let finish!: (object: R2Object | null) => void;
  const waiting = new Promise<R2Object | null>((resolve) => {
    finish = resolve;
  });
  f.head.mockReturnValue(waiting);
  try {
    expect(await f.run()).toBe("held");
    expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: 3 });
  } finally {
    finish(object);
  }
  await waiting;
  expect(await f.ledger()).toMatchObject({ physical_bytes: 0, reserved_bytes: 3 });
  f.head.mockResolvedValue(object);
  expect(await f.run()).toBe("stored");
}, 90_000);
it("uses the real ControlDO to reconcile an old stopped copy while maintenance stays closed", async () => {
  const f = await fixture("multipart");
  await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const control = env.CONTROL.get(env.CONTROL.idFromName("singleton"));
  const status = await control.recover();
  expect(await f.run({ ...env, BLOBS: f.app().BLOBS })).toBe("stored");
  expect(await control.status()).toMatchObject({ epoch: status.epoch, maintenance: true });
  expect(await f.ledger()).toMatchObject({ physical_bytes: f.size, reserved_bytes: f.size });
});
