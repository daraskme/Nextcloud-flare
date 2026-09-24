import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GlobalMutationAdmission, MutationRequest } from "../../src/db/mutationAdmission";
import { abortMultipartBucketHandle } from "../../src/jobs/multipartBucketAbort";
import {
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../../src/jobs/multipartBucketInventory";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { multipartBucketClient, multipartBucketFixture } from "../fixtures/multipartBucket";
import { acquireGlobalMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { partsXml, partXml, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const expire = () =>
  env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await expire();
  await env.DB.prepare(
    "UPDATE multipart_bucket_scan SET round_id=?,cursor_key=NULL,cursor_upload_id=NULL,pages=0,completed_at=NULL",
  )
    .bind(crypto.randomUUID())
    .run();
});
afterEach(() => vi.restoreAllMocks());
const stages = [
  "scan-init",
  "scan-call",
  "scan-page",
  "parts-init",
  "parts-call",
  "parts-page",
  "abort-start",
  "abort-finish",
] as const;
type Stage = (typeof stages)[number];
type Gate = (r: Omit<MutationRequest, "spaceId">) => Promise<GlobalMutationAdmission>;
const prefix = (stage: Stage) => "global:bucket." + stage + ":";
const direct = (stage: Stage) => stage.endsWith("-call") || stage === "abort-start";
const resultBatch = (stage: Stage) => stage.endsWith("-page");
async function fixture(stage: Stage, createOwner = true) {
  const f = await multipartBucketFixture(createOwner),
    s3 = multipartBucketClient(f);
  const found = await scanMultipartBucket(mutationEnv(), env.BLOBS, s3.inventory, 1);
  const handleId = found.handles[0]!.id;
  if (stage.startsWith("abort-"))
    await observeMultipartBucketParts(mutationEnv(), env.BLOBS, s3.inventory, 1, handleId);
  if (stage === "scan-call" || stage === "scan-page")
    await env.DB.prepare(
      "UPDATE multipart_bucket_scan SET round_id=?,cursor_key=NULL,cursor_upload_id=NULL,pages=0,completed_at=NULL",
    )
      .bind(crypto.randomUUID())
      .run();
  s3.uploads.mockClear();
  s3.parts.mockClear();
  s3.binding.mockClear();
  const abort = vi.fn(async () => f.handle.abort());
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "resumeMultipartUpload")
        return (r2Key: string, r2Id: string) => {
          expect([r2Key, r2Id]).toEqual([f.key, f.handle.uploadId]);
          return { abort };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let permit = "";
  const configure = (gate: Gate = acquireGlobalMutation, db = env.DB): GlobalMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireGlobalMutation: (r) => {
        if (r.permitId.startsWith(prefix(stage))) {
          permit = r.permitId;
          return gate(r);
        }
        return acquireGlobalMutation(r);
      },
    },
  });
  const attemptId = crypto.randomUUID();
  const run = (source = configure()) =>
    stage.startsWith("scan-")
      ? scanMultipartBucket(source, bucket, s3.inventory, 1)
      : stage.startsWith("parts-")
        ? observeMultipartBucketParts(source, bucket, s3.inventory, 1, handleId)
        : abortMultipartBucketHandle(source, bucket, s3.inventory, 1, handleId, attemptId);
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
    )
      .bind(permit)
      .first();
  const row = () =>
    env.DB.prepare("SELECT * FROM multipart_bucket_handles WHERE id=?")
      .bind(handleId)
      .first<Record<string, unknown>>();
  const scan = () =>
    env.DB.prepare("SELECT * FROM multipart_bucket_scan").first<Record<string, unknown>>();
  const attempt = () =>
    env.DB.prepare("SELECT * FROM multipart_bucket_abort_attempts WHERE id=?")
      .bind(attemptId)
      .first<Record<string, unknown>>();
  const physical = () =>
    env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes");
  return {
    ...f,
    s3,
    stage,
    handleId,
    abort,
    bucket,
    configure,
    attemptId,
    run,
    receipt,
    row,
    scan,
    attempt,
    physical,
  };
}
function expectNoExtraDispatch(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.s3.uploads).toHaveBeenCalledTimes(f.stage === "scan-page" ? 1 : 0);
  expect(f.s3.parts).toHaveBeenCalledTimes(f.stage === "parts-page" ? 1 : 0);
  expect(f.abort).toHaveBeenCalledTimes(f.stage === "abort-finish" ? 1 : 0);
}
it.each([
  { mode: "unavailable", db: env.TEST_BOOTSTRAP_RACE },
  { mode: "ack", db: env.TEST_BOOTSTRAP_FAILURE },
  { mode: "rollback", db: env.TEST_BOOTSTRAP_LOGIN },
  { mode: "reads", db: env.TEST_BOOTSTRAP_LOST },
] as const)("protects first scan creation with $mode admission", async ({ mode, db }) => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  const f = await multipartBucketFixture(false),
    s3 = multipartBucketClient(f);
  const fault =
    mode === "unavailable" ? null : systemMutationFault(prefix("scan-init"), mode, 1, db);
  let permit = "";
  const source: GlobalMutationSource = {
    DB: fault?.db ?? db,
    systemControl: {
      status: () => mutationEnv(db, db).CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireGlobalMutation: (r) => {
        if (r.permitId.startsWith(prefix("scan-init"))) {
          permit = r.permitId;
          if (mode === "unavailable") return Promise.reject(new Error("queue_full"));
        }
        return acquireGlobalMutation(r, db);
      },
    },
  };
  const run = scanMultipartBucket(source, env.BLOBS, s3.inventory, 1);
  if (mode === "ack") expect(await run).toMatchObject({ examined: 1, completed: true });
  else await expect(run).rejects.toThrow();
  expect(permit).not.toBe("");
  expect(s3.uploads).toHaveBeenCalledTimes(mode === "ack" ? 1 : 0);
  expect(await db.prepare("SELECT COUNT(*) n FROM multipart_bucket_scan").first("n")).toBe(
    mode === "ack" || mode === "reads" ? 1 : 0,
  );
  const receipt = await db
    .prepare("SELECT state,committed_at,space_id FROM mutation_admissions WHERE permit_id=?")
    .bind(permit)
    .first();
  expect(receipt).toEqual(
    mode === "unavailable"
      ? null
      : {
          state: mode === "rollback" ? "active" : "closed",
          committed_at: mode === "rollback" ? null : expect.any(Number),
          space_id: null,
        },
  );
  if (fault) {
    expect(fault.fired()).toBe(true);
    expect(fault.reads()).toBe(1);
  }
});

it.each(stages)("cannot bypass unavailable %s admission", async (stage) => {
  const f = await fixture(stage),
    gate = vi.fn(async () => {
      throw new Error("queue_full");
    });
  await expect(f.run(f.configure(gate))).rejects.toThrow();
  expect(gate).toHaveBeenCalledTimes(1);
  expect(await f.receipt()).toBeNull();
  expectNoExtraDispatch(f);
  expect(await f.physical()).toBe(stage.startsWith("abort-") ? 3 : 0);
  if (stage === "abort-finish") expect(await f.attempt()).toMatchObject({ outcome: "started" });
});
it.each(stages)("recovers only DB facts after %s ACK loss", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "ack");
  if (direct(stage) || resultBatch(stage))
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
  else
    expect(await f.run(f.configure(undefined, fault.db))).toMatchObject(
      stage === "abort-finish"
        ? { outcome: "confirmed", replayed: false }
        : stage === "scan-init"
          ? { completed: true, examined: 1 }
          : { completed: true, heldBytes: 3 },
    );
  expect(fault.fired()).toBe(true);
  expect(await f.receipt()).toEqual({
    state: "closed",
    committed_at: expect.any(Number),
    space_id: null,
    system: 1,
    maintenance: 1,
  });
  expect(fault.reads()).toBe(direct(stage) || resultBatch(stage) ? 0 : 1);
  if (direct(stage)) expectNoExtraDispatch(f);
  if (stage === "abort-start")
    expect(await f.attempt()).toMatchObject({ outcome: "started", ordinal: 1 });
  if (stage === "abort-finish") expect(f.abort).toHaveBeenCalledTimes(1);
  if (stage === "parts-page") expect(await f.physical()).toBe(3);
});
it.each(stages)("rolls back %s without returning its unknown common slot", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "rollback");
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
  expect(fault.fired()).toBe(true);
  expect(await f.receipt()).toEqual({
    state: "active",
    committed_at: null,
    space_id: null,
    system: 1,
    maintenance: 1,
  });
  expectNoExtraDispatch(f);
  expect(await f.physical()).toBe(stage.startsWith("abort-") ? 3 : 0);
  if (stage === "abort-start") expect(await f.attempt()).toBeNull();
  if (stage === "abort-finish") expect(await f.attempt()).toMatchObject({ outcome: "started" });
});
it.each(stages)("fails closed when the %s receipt cannot be read", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "reads");
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
  expect(fault.fired()).toBe(true);
  expect(await f.receipt()).toMatchObject({ state: "closed", committed_at: expect.any(Number) });
  expect(fault.reads()).toBe(direct(stage) || resultBatch(stage) ? 0 : 1);
  expectNoExtraDispatch(f);
  if (stage === "abort-finish") {
    expect(await f.attempt()).toMatchObject({ outcome: "confirmed" });
    await expire();
    expect(await f.run()).toMatchObject({ outcome: "confirmed", replayed: true, heldBytes: 3 });
    expect(f.abort).toHaveBeenCalledTimes(1);
  }
});

const starts = ["scan-call", "parts-call", "abort-start"] as const;
it.each(starts)("checks the fixed deadline after %s waits for a grant", async (stage) => {
  const f = await fixture(stage),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(
    f.run(
      f.configure(async (r) => {
        const grant = await acquireGlobalMutation(r);
        clock.mockReturnValue(now + 25001);
        return grant;
      }),
    ),
  ).rejects.toThrow();
  expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  expectNoExtraDispatch(f);
});
it.each(starts)("checks the fixed deadline after a late %s ACK", async (stage) => {
  const f = await fixture(stage),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const match =
    stage === "scan-call"
      ? "UPDATE multipart_bucket_scan SET calls=calls+1"
      : stage === "parts-call"
        ? "SET part_calls=part_calls+1"
        : "INSERT INTO multipart_bucket_abort_attempts";
  const db = injectBatch(
    (sql) => sql.includes(match),
    async () => {
      clock.mockReturnValue(now + 25001);
    },
    true,
  );
  await expect(f.run(f.configure(undefined, db))).rejects.toThrow();
  expect(await f.receipt()).toMatchObject({ state: "closed", committed_at: expect.any(Number) });
  expectNoExtraDispatch(f);
});
it.each(starts)("includes binding verification time in the %s dispatch deadline", async (stage) => {
  const f = await fixture(stage),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  f.s3.binding.mockImplementationOnce(async () => {
    const result = await f.s3.binding.getMockImplementation()!();
    clock.mockReturnValue(now + 25001);
    return result;
  });
  await expect(f.run()).rejects.toThrow();
  expect(await f.receipt()).toBeNull();
  expectNoExtraDispatch(f);
});

const proofCases = (["scan-page", "parts-page", "abort-start", "abort-finish"] as const).flatMap(
  (stage) =>
    (["lease", "generation", "epoch", "pause"] as const).map((change) => ({ stage, change })),
);
it.each(proofCases)("rechecks proof $change after $stage admission", async ({ stage, change }) => {
  const f = await fixture(stage);
  let changed = false;
  await expect(
    f.run(
      f.configure(async (r) => {
        const grant = await acquireGlobalMutation(r);
        if (change === "lease") await expire();
        if (change === "generation") {
          await expire();
          await env.DB.prepare(`UPDATE r2_binding_probe SET generation=generation+1,nonce=?,phase='claimed',
            lease_token=?,lease_expires_at=strftime('%s','now')*1000+60000,expected_etag=NULL,
            r2_etag=NULL,r2_version=NULL,uploaded_at=NULL,verified_at=NULL`)
            .bind("f".repeat(64), crypto.randomUUID())
            .run();
        }
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "pause") await env.DB.prepare("UPDATE control SET gc_paused=0").run();
        changed = true;
        return grant;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expectNoExtraDispatch(f);
  expect(await f.physical()).toBe(stage.startsWith("abort-") ? 3 : 0);
  if (stage === "abort-start") expect(await f.attempt()).toBeNull();
  if (stage === "abort-finish") expect(await f.attempt()).toMatchObject({ outcome: "started" });
});

const roundCases = (
  ["scan-init", "scan-call", "scan-page", "parts-init", "parts-call", "parts-page"] as const
)
  .map((stage) => ({ stage: stage as Stage, scan: stage.startsWith("scan-") }))
  .concat([
    { stage: "abort-start", scan: true },
    { stage: "abort-start", scan: false },
  ]);
it.each(roundCases)(
  "rejects a replaced walk after $stage admission (scan=$scan)",
  async ({ stage, scan }) => {
    const f = await fixture(stage);
    let changed = false;
    await expect(
      f.run(
        f.configure(async (r) => {
          const grant = await acquireGlobalMutation(r);
          if (scan)
            await env.DB.prepare(
              "UPDATE multipart_bucket_scan SET round_id=?,cursor_key=NULL,cursor_upload_id=NULL,pages=0,completed_at=NULL",
            )
              .bind(crypto.randomUUID())
              .run();
          else
            await env.DB.prepare(
              "UPDATE multipart_bucket_handles SET part_epoch=1,part_round_id=?,part_marker=0,part_pages=0,parts_completed_at=NULL WHERE id=?",
            )
              .bind(crypto.randomUUID(), f.handleId)
              .run();
          changed = true;
          return grant;
        }),
      ),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    expectNoExtraDispatch(f);
    expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
    expect(await f.physical()).toBe(stage === "abort-start" ? 3 : 0);
    if (stage === "abort-start") expect(await f.attempt()).toBeNull();
  },
);

it.each([0, 1, 3])(
  "returns exactly %s discovery results without exposing receipt rows",
  async (count) => {
    const f = await fixture("scan-page");
    f.s3.uploads.mockResolvedValueOnce(
      new Response(
        uploadsXml({
          uploads: Array.from({ length: count }, (_, i) =>
            uploadXml(f.key, f.handle.uploadId + "-" + i),
          ).join(""),
        }),
      ),
    );
    const result = await f.run();
    expect(result).toMatchObject({
      examined: count,
      completed: true,
      handles: Array.from({ length: count }, () => ({
        id: expect.any(String),
        state: "quarantined",
      })),
    });
  },
);
it("preserves held bytes through a lost part-page reply and a smaller follow-up observation", async () => {
  const f = await fixture("parts-page"),
    fault = systemMutationFault(prefix("parts-page"), "ack");
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
  expect(await f.physical()).toBe(3);
  await expire();
  f.s3.parts.mockResolvedValueOnce(
    new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: partXml(1, 1) })),
  );
  expect(await f.run()).toMatchObject({ heldBytes: 3, observed: 1, completed: true });
  expect(await f.physical()).toBe(3);
});
