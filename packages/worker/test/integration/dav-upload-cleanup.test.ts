import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { runGarbageCollection } from "../../src/jobs/gc";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import { settleFailedDavUpload } from "../../src/services/davUpload";
import { type UploadRow, uploadFence, uploadRow } from "../../src/services/uploads/access";
import { davUploadHistory as history } from "../fixtures/davUploadHistory";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run());

it.each([false, true])(
  "recovers expired unknown DAV storage (present=%s) through the shared cleanup and GC",
  async (present) => {
    const f = await history({ present });
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
    const result = await repairSingleUploads(mutationEnv(), env.BLOBS, 1);
    expect(result).toMatchObject({
      claimed: 1,
      absent: present ? 0 : 1,
      queued: present ? 1 : 0,
      retried: 0,
    });
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: present ? 3 : 0 });
    expect(
      await env.DB.prepare("SELECT state FROM operations WHERE op_id=?")
        .bind(f.operationId)
        .first("state"),
    ).toBe("failed");
    if (present) {
      expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
      expect(await env.BLOBS.head(f.key)).toBeNull();
      expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
    }
  },
);
it("does not treat an absent object before DAV expiry as a finished PUT", async () => {
  const f = await history({ expired: false });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 0,
    r2Calls: 0,
  });
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
});
it("quarantines an object with different attempt metadata without refunding or deleting it", async () => {
  const f = await history();
  await env.BLOBS.put(f.key, "abc", { customMetadata: { ...f.metadata, attempt_id: "different" } });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 1,
    retried: 1,
  });
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 0 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
});
it.each(["committed", "step"] as const)(
  "never cleans DAV publication with %s evidence",
  async (evidence) => {
    const f = await history({
      present: true,
      operationState: evidence === "committed" ? "committed" : "claimed",
    });
    if (evidence === "step")
      await env.DB.prepare(
        "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      )
        .bind(f.operationId, f.ids.file)
        .run();
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
      claimed: 0,
      r2Calls: 0,
    });
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  },
);
it("keeps the internal DAV ledger out of private capability access and freezes its source", async () => {
  const f = await history({ expired: false });
  await expect(uploadRow(env.DB, f.id)).rejects.toThrow("invalid_upload_id");
  await expect(
    atomicBatch(env.DB, [uploadFence(f.row as unknown as UploadRow, ["receiving"])]),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE uploads SET source='private' WHERE id=?").bind(f.id).run(),
  ).rejects.toThrow("immutable_upload_source");
  await expect(
    env.DB.prepare("UPDATE uploads SET completion_op_id=NULL WHERE id=?").bind(f.id).run(),
  ).rejects.toThrow("immutable_upload_completion");
});
it("replays known failed settlement after GC without acquiring another slot", async () => {
  const f = await history({ state: "completing", present: true });
  await settleFailedDavUpload(mutationEnv(), f.row);
  await repairSingleUploads(mutationEnv(), env.BLOBS, 1);
  await runGarbageCollection(mutationEnv(), env.BLOBS, 1);
  const unavailable = {
    DB: env.DB,
    systemControl: {
      status: async () => {
        throw new Error("unexpected_admission");
      },
      acquireSystemMutation: async () => {
        throw new Error("unexpected_admission");
      },
    },
  };
  await settleFailedDavUpload(unavailable, f.row);
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
});
