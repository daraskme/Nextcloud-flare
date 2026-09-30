import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { abortMultipartBucketHandle } from "../../src/jobs/multipartBucketAbort";
import {
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../../src/jobs/multipartBucketInventory";
import { foundationFixture } from "../fixtures/foundation";
import { multipartBucketClient, multipartBucketFixture } from "../fixtures/multipartBucket";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2,
  space = "";
const expire = () =>
  env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
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
});
beforeEach(async () => {
  await control().quiesce(epoch);
  await expire();
  await env.DB.prepare(
    "UPDATE multipart_bucket_scan SET round_id=?,cursor_key=NULL,cursor_upload_id=NULL,pages=0,completed_at=NULL",
  )
    .bind(crypto.randomUUID())
    .run();
});
afterEach(() => vi.restoreAllMocks());
const kinds = [
  "scan-init",
  "scan-call",
  "scan-page",
  "parts-init",
  "parts-call",
  "parts-page",
  "abort-start",
  "abort-finish",
] as const;
async function fill() {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        (i % 2 ? "global:orphan.scan-page:" : "system:upload.observe:") + id,
        i % 2 ? null : space,
        epoch,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
  return ids;
}
it.each(kinds)("native %s waits behind the shared stopped-mode pool", async (kind) => {
  const f = await multipartBucketFixture(false),
    s3 = multipartBucketClient(f);
  let handleId = "";
  if (!kind.startsWith("scan-"))
    handleId = (await scanMultipartBucket(mutationEnv(), env.BLOBS, s3.inventory, epoch))
      .handles[0]!.id;
  if (kind.startsWith("abort-"))
    await observeMultipartBucketParts(mutationEnv(), env.BLOBS, s3.inventory, epoch, handleId);
  // After the first test the durable scan exists; completed forces the reset branch too.
  if (kind === "scan-init")
    await env.DB.prepare("UPDATE multipart_bucket_scan SET completed_at=1").run();
  s3.uploads.mockClear();
  s3.parts.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    s3.fetch(new Request(input, init)),
  );
  let ids: string[] = [],
    permit = "";
  const prefix = "global:bucket." + kind + ":";
  const pending = runInDurableObject(control(), async (_, state) => {
    const instance = new ControlDO(state, { ...env, ...inventoryEnv });
    const native = instance.acquireGlobalMutation.bind(instance);
    instance.acquireGlobalMutation = async (r) => {
      if (!permit && r.permitId.startsWith(prefix)) {
        permit = r.permitId;
        ids = await fill();
      }
      return native(r);
    };
    try {
      return await (kind.startsWith("scan-")
        ? instance.inventoryMultipartBucket(epoch)
        : kind.startsWith("parts-")
          ? instance.observeMultipartBucketParts(epoch, handleId)
          : instance.abortMultipartBucketHandle(epoch, handleId, crypto.randomUUID()));
    } finally {
      instance.acquireGlobalMutation = native;
    }
  });
  try {
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
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM mutation_admissions WHERE state='active'").first(
        "n",
      ),
    ).toBe(32);
    if (kind === "scan-call") expect(s3.uploads).not.toHaveBeenCalled();
    if (kind === "parts-call") expect(s3.parts).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
      .bind(ids[0]!)
      .run();
    const result = await pending;
    expect(result).toMatchObject(
      kind.startsWith("scan-")
        ? { inventory: { examined: 1, completed: true } }
        : kind.startsWith("parts-")
          ? { observation: { observed: 1, heldBytes: 3, completed: true } }
          : { abort: { outcome: "confirmed", replayed: false, heldBytes: 3 } },
    );
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
    expect(
      await env.DB.prepare("SELECT owner_id FROM multipart_bucket_handles WHERE r2_key=?")
        .bind(f.key)
        .first("owner_id"),
    ).toBeNull();
    expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
  } finally {
    await env.DB.prepare(
      "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
    ).run();
    await pending;
  }
});
it("never resends an abort attempt after its direct ACK is lost across coordinator eviction", async () => {
  const f = await multipartBucketFixture(),
    s3 = multipartBucketClient(f);
  const handleId = (await scanMultipartBucket(mutationEnv(), env.BLOBS, s3.inventory, epoch))
    .handles[0]!.id;
  await observeMultipartBucketParts(mutationEnv(), env.BLOBS, s3.inventory, epoch, handleId);
  const abort = vi.fn(async () => f.handle.abort());
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "resumeMultipartUpload") return () => ({ abort });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const attemptId = crypto.randomUUID(),
    fault = systemMutationFault("global:bucket.abort-start:", "reads");
  const run = (db = env.DB) =>
    abortMultipartBucketHandle(
      { ...env, DB: db },
      bucket,
      s3.inventory,
      epoch,
      handleId,
      attemptId,
    );
  await expect(run(fault.db)).rejects.toThrow();
  expect(fault.fired()).toBe(true);
  expect(fault.reads()).toBe(0);
  expect(abort).not.toHaveBeenCalled();
  await evictDurableObject(control());
  await expire();
  expect(await run()).toMatchObject({ outcome: "unconfirmed", replayed: true, heldBytes: 3 });
  expect(abort).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(3);
  expect(
    await abortMultipartBucketHandle(
      env,
      bucket,
      s3.inventory,
      epoch,
      handleId,
      crypto.randomUUID(),
    ),
  ).toMatchObject({ outcome: "confirmed", replayed: false, heldBytes: 3 });
  expect(abort).toHaveBeenCalledTimes(1);
});
