import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import { nativeIdentity } from "../../src/do/nativeHistory";
import {
  prepareImageDerivative,
  publishImageDerivative,
  resumeImageDerivative,
  storeImageDerivative,
} from "../../src/jobs/imageDerivative";
import { maintainImageDerivatives } from "../../src/jobs/imageDerivativeCleanup";
import { auditOwnerLedger } from "../../src/services/refs";
import { imageDerivativeFixture } from "../fixtures/imageDerivative";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { rollbackNativeReceipt } from "../fixtures/nativeRollback";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET restore_freeze_token=NULL,backup_frozen=0,backup_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

async function fixture(state: "stored" | "published" | "prepared" = "stored") {
  const f = await imageDerivativeFixture();
  const claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  if (state === "stored") {
    const db = injectBatch(
      (sql) => sql.includes("UPDATE derivative_results SET state='ready'"),
      async () => {
        throw new Error("publication unavailable");
      },
      false,
    );
    await expect(storeImageDerivative({ ...f.app, DB: db }, f.grant.id, f.output)).rejects.toThrow(
      "publication unavailable",
    );
  } else if (state === "published") await storeImageDerivative(f.app, f.grant.id, f.output);
  const renew = async () => {
    const request = {
      imageId: f.grant.id,
      outboxId: f.grant.outboxId,
      epoch: 1,
      claimToken: crypto.randomUUID(),
      expiresAt: Date.now() + 25000,
    };
    await env.DB.prepare("UPDATE outbox SET claim_token=?,claim_expires_at=? WHERE outbox_id=?")
      .bind(request.claimToken, request.expiresAt, request.outboxId)
      .run();
    return request;
  };
  const result = {
    id: claim.blobId,
    blobId: claim.blobId,
    key: claim.key,
    size: f.output.bytes.length,
    mime: "image/webp",
  };
  const native = async () => ({
    images: await env.DB.prepare("SELECT * FROM image_transform_attempts WHERE id=?")
      .bind(f.grant.id)
      .first(),
    writes: (
      await env.DB.prepare("SELECT * FROM r2_write_attempts WHERE r2_key=? ORDER BY id")
        .bind(claim.key)
        .all()
    ).results,
    reservation: await env.DB.prepare(
      "SELECT bytes,epoch,expires_at,physical_only FROM reservations WHERE id=?",
    )
      .bind(claim.blobId)
      .first(),
  });
  return { ...f, claim, renew, result, native };
}

it("finishes a stored image under the new delivery claim without changing native receipts or capacity", async () => {
  const f = await fixture(),
    native = await f.native(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  const request = await f.renew();
  // No BLOBS or IMAGES binding is available to the resumption path.
  const app = { DB: env.DB, CONTROL: f.app.CONTROL };
  expect(await resumeImageDerivative(app, request)).toEqual(f.result);
  expect(await f.saved()).toMatchObject({
    state: "ready",
    claim_token: request.claimToken,
    claim_expires_at: request.expiresAt,
    attempts: 1,
  });
  expect(await f.native()).toEqual(native);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    used_bytes: before!.used_bytes,
    physical_bytes: before!.physical_bytes,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT next_at,retired_at FROM image_derivative_cleanup WHERE image_id=?")
      .bind(f.grant.id)
      .first(),
  ).toEqual({ next_at: Number.MAX_SAFE_INTEGER, retired_at: null });
  expect(await resumeImageDerivative(app, await f.renew())).toEqual(f.result);
  expect(await f.native()).toEqual(native);
  await expect(publishImageDerivative(f.app, f.claim)).rejects.toThrow();
});

it("publishes after the original Images and result deadlines really expire", async () => {
  const f = await fixture(),
    retired = await fixture();
  // Real time is required: Workers Date mocks do not advance D1 strftime.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, retired.grant.expiresAt - Date.now()) + 1100),
  );
  expect(
    await env.DB.prepare(
      "SELECT expires_at<=strftime('%s','now')*1000 AS expired FROM image_transform_attempts WHERE id=?",
    )
      .bind(f.grant.id)
      .first("expired"),
  ).toBe(1);
  await expect(publishImageDerivative(f.app, f.claim)).rejects.toThrow("image_derivative_expired");
  expect(await resumeImageDerivative(f.app, await f.renew())).toEqual(f.result);
  await env.DB.prepare("UPDATE image_derivative_cleanup SET next_at=0 WHERE image_id=?")
    .bind(retired.grant.id)
    .run();
  const base = retired.app.CONTROL.get(retired.app.CONTROL.idFromName(CONTROL_NAME));
  const stopped = {
    ...retired.app,
    CONTROL: {
      idFromName: retired.app.CONTROL.idFromName.bind(retired.app.CONTROL),
      get: () => ({
        ...base,
        sealImageDerivative: async () => {
          throw new Error("seal RPC unavailable");
        },
      }),
    } as unknown as typeof env.CONTROL,
  };
  expect(await maintainImageDerivatives(stopped, 1, { imageId: retired.grant.id })).toMatchObject({
    retired: 1,
    held: 1,
    settled: 0,
  });
  expect(await retired.saved()).toMatchObject({ state: "failed", error_code: "image_retired" });
  await expect(resumeImageDerivative(retired.app, await retired.renew())).rejects.toThrow();
  expect(await auditOwnerLedger(env.DB, retired.ids.user)).toMatchObject({
    image_reserved_bytes: retired.output.bytes.length,
  });
}, 45000);

it("reuses an already published result only after checking the current delivery authority", async () => {
  const f = await fixture("published"),
    before = await f.saved();
  expect(await resumeImageDerivative(f.app, await f.renew())).toEqual(f.result);
  expect(await f.saved()).toEqual(before);
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.input.principal.credential_id.slice(3))
    .run();
  await expect(resumeImageDerivative(f.app, await f.renew())).rejects.toThrow();
  expect(await f.saved()).toEqual(before);
});

it.each(["credential", "parent", "source", "claim", "epoch", "maintenance", "freeze"])(
  "rejects a stale publication at the final batch: %s",
  async (kind) => {
    const f = await fixture(),
      request = await f.renew();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE derivative_results SET claim_token=?"),
      async () => {
        if (kind === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
            .bind(Date.now(), f.input.principal.credential_id.slice(3))
            .run();
        if (kind === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
        if (kind === "source")
          await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
            .bind(f.ids.blob, f.node.id)
            .run();
        if (kind === "claim")
          await env.DB.prepare("UPDATE outbox SET claim_token=? WHERE outbox_id=?")
            .bind(crypto.randomUUID(), request.outboxId)
            .run();
        if (kind === "epoch")
          await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
        if (kind === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (kind === "freeze")
          await env.DB.prepare("UPDATE control SET restore_freeze_token=?")
            .bind(crypto.randomUUID())
            .run();
      },
      false,
    );
    await expect(resumeImageDerivative({ ...f.app, DB: db }, request)).rejects.toThrow();
    expect(await f.saved()).toMatchObject({ state: "running", claim_token: f.grant.claimToken });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      image_reserved_bytes: f.output.bytes.length,
    });
    await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  },
);

it.each(["ack", "rollback"])(
  "handles a publication %s without partial quota release",
  async (when) => {
    const f = await fixture(),
      request = await f.renew();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE derivative_results SET claim_token=?"),
      async () => {
        throw new Error("lost");
      },
      when === "ack",
    );
    if (when === "ack")
      expect(await resumeImageDerivative({ ...f.app, DB: db }, request)).toEqual(f.result);
    else {
      await expect(resumeImageDerivative({ ...f.app, DB: db }, request)).rejects.toThrow("lost");
      expect(await f.saved()).toMatchObject({ state: "running", claim_token: f.grant.claimToken });
      expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
        image_reserved_bytes: f.output.bytes.length,
      });
    }
    expect(await resumeImageDerivative(f.app, request)).toEqual(f.result);
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({ image_reserved_bytes: 0 });
  },
);

it("does not infer native PUT completion from recorded physical storage", async () => {
  const f = await fixture(),
    request = await f.renew();
  const write = await env.DB.prepare(
    "SELECT id FROM r2_write_attempts WHERE kind='image.put' AND r2_key=?",
  )
    .bind(f.claim.key)
    .first<string>("id");
  await rollbackNativeReceipt(env.DB, "r2_write_attempts", write!);
  await expect(resumeImageDerivative(f.app, request)).rejects.toThrow();
  expect(await f.saved()).toMatchObject({ state: "running" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});

it("rejects a changed native tuple even when D1 still reports success", async () => {
  const f = await fixture(),
    request = await f.renew();
  const write = (await f.native()).writes[0]!;
  // Restore a different token in D1 only; the independent completion hash retains the real tuple.
  await rollbackNativeReceipt(env.DB, "r2_write_attempts", write.id as string, {
    token: crypto.randomUUID(),
  });
  await env.DB.prepare(
    "UPDATE r2_write_attempts SET state='succeeded',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE id=?",
  )
    .bind(write.id)
    .run();
  await expect(resumeImageDerivative(f.app, request)).rejects.toThrow(
    "image_storage_history_missing",
  );
  expect(await f.saved()).toMatchObject({ state: "running" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});

it.each(["images", "native", "seal", "pending"])(
  "refuses D1 success when independent %s evidence is missing or closed",
  async (kind) => {
    const f = await fixture(),
      request = await f.renew(),
      native = await f.native();
    const w = native.writes[0]!;
    const identity = await nativeIdentity("r2", [
      w.id,
      w.token,
      w.epoch,
      w.owner_id,
      w.kind,
      w.r2_key,
      w.dispatch_before,
      w.started_at,
      w.source_ref,
    ]);
    await runInDurableObject(control(), (_, state) => {
      const sql = state.storage.sql;
      if (kind === "images" || kind === "native") {
        const triggerName =
          kind === "images" ? "control_image_keep" : "control_native_history_retention";
        const trigger = sql
          .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name=?", triggerName)
          .toArray()[0]!.sql;
        // Simulated loss of independent history, while the restored D1 success row is unchanged.
        state.storage.transactionSync(() => {
          sql.exec(`DROP TRIGGER ${triggerName}`);
          if (kind === "images")
            sql.exec("DELETE FROM control_image_transforms WHERE id=?", f.grant.id);
          else sql.exec("DELETE FROM control_native_history WHERE identity=?", identity);
          sql.exec(trigger);
        });
      } else if (kind === "seal") {
        const original = sql
          .exec<{ grant_json: string; output_json: string }>(
            "SELECT grant_json,output_json FROM control_image_transforms WHERE id=?",
            f.grant.id,
          )
          .toArray()[0]!;
        // State after D1 retirement rollback: independent immutable seal survives.
        sql.exec(
          "INSERT INTO control_image_derivative_seals VALUES(?,?,?,?,?)",
          f.grant.id,
          f.claim.key,
          crypto.randomUUID(),
          original.grant_json,
          original.output_json,
        );
      } else {
        const id = crypto.randomUUID(),
          token = crypto.randomUUID();
        sql.exec(
          "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
          id,
          token,
          JSON.stringify({
            id,
            token,
            epoch: 1,
            ownerId: f.ids.user,
            kind: "image.put",
            key: f.claim.key,
            startedAt: Date.now(),
            deadline: Date.now() + 5000,
          }),
        );
      }
    });
    await expect(resumeImageDerivative(f.app, request)).rejects.toThrow();
    expect(await f.native()).toEqual(native);
    expect(await f.saved()).toMatchObject({ state: "running" });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      image_reserved_bytes: f.output.bytes.length,
    });
  },
);

it("uses the actual ControlDO proof RPC and common publication admission", async () => {
  const f = await fixture(),
    request = await f.renew();
  const mirror = (await env.DB.prepare(
    "SELECT admission_revision,admission_token,gc_paused,gc_operator_paused,gc_hold_token,gc_hold_operation,gc_hold_expires_at FROM control WHERE singleton=1",
  ).first<Record<string, string | number | null>>())!;
  await runInDurableObject(control(), (_, state) => {
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1");
    state.storage.sql.exec(
      "UPDATE control_admission SET epoch=1,revision=?,token=?,phase='open',gc_paused=? WHERE singleton=1",
      mirror.admission_revision!,
      mirror.admission_token!,
      mirror.gc_paused!,
    );
    state.storage.sql.exec(
      "UPDATE control_gc_policy SET epoch=1,operator_paused=?,hold_token=?,hold_operation=?,hold_expires_at=?,prior_gc_paused=? WHERE singleton=1",
      mirror.gc_operator_paused!,
      mirror.gc_hold_token!,
      mirror.gc_hold_operation!,
      mirror.gc_hold_expires_at!,
      mirror.gc_paused!,
    );
  });
  expect(await resumeImageDerivative(env, request)).toEqual(f.result);
  await evictDurableObject(control());
  expect(await resumeImageDerivative(env, await f.renew())).toEqual(f.result);
  await control().quiesce(1);
  // A rejecting RpcPromise passed directly to a Vitest matcher can escape the Workers harness.
  // Positive calls above exercise the actual RPC; handle this expected denial inside the DO.
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.imageDerivativePublicationProof(1, f.grant.id)).rejects.toThrow(
      "mutation_unavailable",
    );
  });
});

it("does not create a new native dispatch from a prepared generation", async () => {
  const f = await fixture("prepared"),
    before = await f.native();
  await expect(resumeImageDerivative(f.app, await f.renew())).rejects.toThrow(
    "image_derivative_unavailable",
  );
  expect(await f.native()).toEqual(before);
});

it.each(["checksum", "etag"])("rejects inconsistent stored %s evidence", async (kind) => {
  const f = await fixture();
  if (kind === "checksum")
    await env.DB.prepare("UPDATE blobs SET sha256_verified=? WHERE id=?")
      .bind("f".repeat(64), f.claim.blobId)
      .run();
  if (kind === "etag")
    await env.DB.prepare("UPDATE blobs SET r2_etag='changed' WHERE id=?")
      .bind(f.claim.blobId)
      .run();
  await expect(resumeImageDerivative(f.app, await f.renew())).rejects.toThrow();
  expect(await f.saved()).toMatchObject({ state: "running" });
});

it("allows concurrent delivery completion to publish at most once and converge on its receipt", async () => {
  const f = await fixture(),
    request = await f.renew();
  const results = await Promise.allSettled([
    resumeImageDerivative(f.app, request),
    resumeImageDerivative(f.app, request),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(await resumeImageDerivative(f.app, request)).toEqual(f.result);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    incorrect_refs: 0,
  });
  expect((await f.native()).writes).toHaveLength(1);
});

it.each(["outbox", "epoch", "claim", "expired", "excessive"])(
  "rejects an unrelated or invalid request: %s",
  async (kind) => {
    const f = await fixture(),
      request = await f.renew();
    if (kind === "outbox") request.outboxId = "different-event";
    if (kind === "epoch") request.epoch = 2;
    if (kind === "claim") request.claimToken = crypto.randomUUID();
    if (kind === "expired") request.expiresAt = Date.now() - 1;
    if (kind === "excessive") request.expiresAt = Date.now() + 60000;
    await expect(resumeImageDerivative(f.app, request)).rejects.toThrow();
    expect(await f.saved()).toMatchObject({ state: "running" });
  },
);

it("retains one request identity if its caller mutates the object during admission", async () => {
  const f = await fixture(),
    request = await f.renew(),
    expected = { ...request };
  const db = injectBatch(
    (sql) => sql.includes("UPDATE derivative_results SET claim_token=?"),
    async () => {
      request.claimToken = crypto.randomUUID();
      request.expiresAt = 0;
    },
    false,
  );
  expect(await resumeImageDerivative({ ...f.app, DB: db }, request)).toEqual(f.result);
  expect(await f.saved()).toMatchObject({
    claim_token: expected.claimToken,
    claim_expires_at: expected.expiresAt,
  });
});
