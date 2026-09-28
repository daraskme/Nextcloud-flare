import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { copyNextSmallBlob } from "../../src/jobs/copyPut";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture as fixture } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
function app(db = env.DB) {
  const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  return {
    ...mutationEnv(db, db),
    BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket,
    put,
  };
}
async function stored(id: string) {
  return env.DB.prepare(
    "SELECT transfer_state,transfer_attempt,transfer_sha256 FROM copy_job_blobs WHERE job_id=?",
  )
    .bind(id)
    .first<{ transfer_state: string; transfer_attempt: string; transfer_sha256: string }>();
}
async function position(id: string) {
  return env.DB.prepare("SELECT checkpoint FROM bulk_jobs WHERE id=?").bind(id).first("checkpoint");
}
it("grants native PUT from bounded identity rows without reloading manifest chunks", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("FROM copy_job_chunks")) throw new Error("unbounded_manifest_reload");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await copyNextSmallBlob(app(db), claim)).toBe("stored");
});
it.each([false, true])(
  "copies an immutable small blob, accounts physical bytes, and advances once (empty=%s)",
  async (empty) => {
    const f = await fixture(empty),
      claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
      a = app();
    expect(await copyNextSmallBlob(a, claim)).toBe("stored");
    expect(await copyNextSmallBlob(a, claim)).toBe("ready");
    expect(a.put).toHaveBeenCalledTimes(1);
    expect(await position(claim.id)).toBe('{"v":1,"blob":1,"offset":0}');
    expect(await stored(claim.id)).toMatchObject({ transfer_state: "stored" });
    const object = await env.BLOBS.get(`u/${f.target.ids.user}/b/${claim.id}_b00001`);
    expect(await object!.text()).toBe(empty ? "" : "abc");
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      used_bytes: 3,
      reserved_bytes: empty ? 0 : 3,
      physical_bytes: empty ? 0 : 3,
      incorrect_refs: 0,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner_id=?")
        .bind(f.target.ids.user)
        .first("n"),
    ).toBe(3);
    expect(
      await env.DB.prepare("SELECT state FROM blobs WHERE id=?")
        .bind(claim.id + "_b00001")
        .first("state"),
    ).toBe("staging");
    await releaseCopyJobClaim(mutationEnv(), claim);
    const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
    expect(await copyNextSmallBlob(a, resumed)).toBe("ready");
    expect(a.put).toHaveBeenCalledTimes(1);
  },
);
it("does not dispatch after a lost prepare ACK or replay the retained attempt", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
      (sql) => sql.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
      async () => {
        throw new Error("prepare_ack_lost");
      },
      true,
    ),
    a = app(db);
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow("prepare_ack_lost");
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow("copy_write_unsettled");
  expect(a.put).not.toHaveBeenCalled();
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "claimed" });
  await expect(
    env.DB.prepare("DELETE FROM blobs WHERE id=?")
      .bind(claim.id + "_b00001")
      .run(),
  ).rejects.toThrow("copy_destination_held");
  await expect(
    env.DB.prepare("UPDATE blobs SET state='deleted' WHERE id=?")
      .bind(claim.id + "_b00001")
      .run(),
  ).rejects.toThrow("copy_destination_held");
});
it("reauthorizes inside the native grant batch after preparation", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO r2_write_attempts"),
      async () => {
        await f.revoke();
      },
      false,
    ),
    a = app(db);
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow();
  expect(a.put).not.toHaveBeenCalled();
  expect(await position(claim.id)).toBe('{"v":1,"blob":0,"offset":0}');
});
it("retains unknown PUT and quota after a lost native response", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  a.put.mockImplementation(async (...args: Parameters<R2Bucket["put"]>) => {
    await env.BLOBS.put(...args);
    throw new Error("native_ack_lost");
  });
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow();
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "claimed" });
  expect(
    await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE r2_key=?")
      .bind(`u/${f.target.ids.user}/b/${claim.id}_b00001`)
      .first("state"),
  ).toBe("pending");
  await releaseCopyJobClaim(mutationEnv(), claim);
  await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
  expect(a.put).toHaveBeenCalledTimes(1);
});
it.each(["observe", "advance"])("recovers a lost %s ACK without repeating PUT", async (phase) => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
      (sql) =>
        sql.startsWith(
          phase === "observe" ? "INSERT INTO blob_storage" : "UPDATE bulk_jobs SET checkpoint",
        ),
      async () => {
        throw new Error("ack_lost");
      },
      true,
    ),
    a = app(db);
  expect(await copyNextSmallBlob(a, claim)).toBe("stored");
  expect(await copyNextSmallBlob(a, claim)).toBe("ready");
  expect(a.put).toHaveBeenCalledTimes(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    physical_bytes: 3,
    reserved_bytes: 3,
  });
});
it("retries an uncommitted object observation after recording native success", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const a = app(
    injectBatch(
      (sql) => sql.startsWith("INSERT INTO blob_storage"),
      async () => {
        throw new Error("observation_rollback");
      },
      false,
    ),
  );
  expect(await copyNextSmallBlob(a, claim)).toBe("stored");
  expect(a.put).toHaveBeenCalledTimes(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    physical_bytes: 3,
    reserved_bytes: 3,
  });
});
it("uses stored evidence after a native finish ACK is lost", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  const control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
  const broken = {
    ...a,
    CONTROL: {
      idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
      get: () => ({
        ...control,
        finishR2Write: async (...args: Parameters<typeof control.finishR2Write>) => {
          await control.finishR2Write(...args);
          throw new Error("finish_ack_lost");
        },
      }),
    } as unknown as Env["CONTROL"],
  };
  await expect(copyNextSmallBlob(broken, claim)).rejects.toThrow();
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "stored" });
  expect(await position(claim.id)).toBe('{"v":1,"blob":0,"offset":0}');
  await releaseCopyJobClaim(mutationEnv(), claim);
  const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await copyNextSmallBlob(a, resumed)).toBe("stored");
  expect(a.put).toHaveBeenCalledTimes(1);
});
it("records actual storage after revocation while refusing checkpoint publication", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  a.put.mockImplementation(async (...args: Parameters<R2Bucket["put"]>) => {
    const object = await env.BLOBS.put(...args);
    await f.revoke();
    return object;
  });
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow();
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "stored" });
  expect(await position(claim.id)).toBe('{"v":1,"blob":0,"offset":0}');
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    physical_bytes: 3,
    reserved_bytes: 3,
  });
});
it("does not overwrite an unexpected object or mark a rejected conditional PUT stored", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  const key = `u/${f.target.ids.user}/b/${claim.id}_b00001`;
  await env.BLOBS.put(key, "other");
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow("copy_destination_exists");
  expect(await (await env.BLOBS.get(key))!.text()).toBe("other");
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "claimed" });
  expect(await position(claim.id)).toBe('{"v":1,"blob":0,"offset":0}');
});
it("reauthorizes a fully transferred claim instead of trusting its local checkpoint", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  await copyNextSmallBlob(a, claim);
  await f.revoke();
  await expect(copyNextSmallBlob(a, claim)).rejects.toThrow();
  expect(a.put).toHaveBeenCalledTimes(1);
});
it("retains a late successful PUT after lease release without advancing the old claim", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = app();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
  a.put.mockImplementation(async (...args: Parameters<R2Bucket["put"]>) => {
    entered();
    await wait;
    return env.BLOBS.put(...args);
  });
  const copying = copyNextSmallBlob(a, claim),
    rejected = expect(copying).rejects.toThrow();
  await started;
  await releaseCopyJobClaim(mutationEnv(), claim);
  await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
  finish();
  await rejected;
  expect(await stored(claim.id)).toMatchObject({ transfer_state: "stored" });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    physical_bytes: 3,
    reserved_bytes: 3,
  });
  const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await copyNextSmallBlob(a, resumed)).toBe("stored");
  expect(a.put).toHaveBeenCalledTimes(1);
});
