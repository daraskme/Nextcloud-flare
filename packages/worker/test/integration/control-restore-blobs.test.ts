import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreBlobs } from "../../src/do/controlRestoreBlobs";
import { ControlRestoreTarget } from "../../src/do/controlRestoreTarget";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { BindingVerificationSource } from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const target = {
  mode: "remote" as const,
  databaseId: "00000000-0000-0000-0000-000000000000",
  accountId: "a".repeat(32),
};
const source = {
  accountId: target.accountId,
  bucket: "test-blobs",
  jurisdiction: "default" as const,
};
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch: number, id: string, c: RestoreD1Challenge;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
});
beforeEach(async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await control().attestDatabaseRestoreD1(epoch, id, c);
});
afterEach(() => vi.restoreAllMocks());
const probe = () =>
  env.DB.prepare("SELECT * FROM r2_binding_probe").first<Record<string, unknown>>();
const readS3 = async () => {
  const object = await env.BLOBS.get(BINDING_PROBE_KEY);
  return object ? new Response(object.body) : new Response(null, { status: 404 });
};
function row(state: DurableObjectState) {
  return state.storage.sql
    .exec("SELECT * FROM control_database_restore_blobs WHERE id=?", id)
    .toArray()[0];
}
function fixture(
  state: DurableObjectState,
  instance: ControlDO,
  options: {
    get?: () => Promise<void>;
    put?: () => Promise<void>;
    s3?: () => Promise<Response>;
    db?: D1Database;
    mutations?: BindingVerificationSource;
    inventory?: R2S3Inventory;
  } = {},
) {
  const db = options.db ?? env.DB;
  const get = vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
    const value = await env.BLOBS.get(...args);
    await options.get?.();
    return value;
  });
  const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
    const value = await env.BLOBS.put(...args);
    await options.put?.();
    return value;
  });
  const transport = vi.fn(options.s3 ?? readS3);
  const targetVerifier = new ControlRestoreTarget(
    state.storage.sql,
    db,
    new ControlDatabaseRestore(state.storage.sql),
    () =>
      state.storage.sql
        .exec<{ epoch: number; revision: number; token: string }>(
          "SELECT epoch,revision,token FROM control_admission WHERE phase='closed'",
        )
        .one(),
    async () => {
      throw new Error("unexpected_stop");
    },
  );
  const service = new ControlRestoreBlobs(
    state.storage.sql,
    options.mutations ?? { DB: db, systemControl: instance },
    { get, put } as unknown as R2Bucket,
    targetVerifier,
    () => options.inventory ?? new R2S3Inventory(inventoryEnv, { fetch: transport }),
  );
  return { service, get, put, transport, verify: () => service.verify(epoch, id, c, source) };
}

it("verifies through configured ControlDO, persists across eviction and refreshes the actual probe", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(readS3);
  let previous = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await runInDurableObject(control(), async (_instance, state) => {
      const configured = new ControlDO(state, { ...env, ...inventoryEnv });
      const result = await configured.verifyDatabaseRestoreBlobs(epoch, id, c, source);
      expect(result).toMatchObject({
        id,
        epoch,
        target,
        source,
        state: "blobs_verified",
        validator: "r2-binding-v1",
        challengeId: c.challengeId,
        revision: c.revision,
        expiresAt: c.expiresAt,
      });
      expect(result).not.toHaveProperty("token");
      expect(result).not.toHaveProperty("nonce");
      expect(row(state)).toMatchObject({
        verified_at: result.verifiedAt,
        source_json: JSON.stringify(source),
        attempt_id: result.attemptId,
        target_json: JSON.stringify(target),
      });
    });
    const p = await probe();
    expect(p).toMatchObject({ phase: "idle", allocated_bytes: 64, lease_token: null });
    expect(p!.nonce).not.toBe(previous);
    previous = p!.nonce as string;
    await evictDurableObject(control());
  }
  expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
});

it.each(["bucket", "accountId", "jurisdiction"] as const)(
  "rejects mismatched %s before any probe call",
  async (field) => {
    await runInDurableObject(control(), async (instance, state) => {
      const f = fixture(state, instance),
        changed = {
          ...source,
          [field]:
            field === "accountId"
              ? "b".repeat(32)
              : field === "jurisdiction"
                ? "eu"
                : "other-bucket",
        };
      await expect(f.service.verify(epoch, id, c, changed)).rejects.toThrow(
        /blobs_target_mismatch/,
      );
      expect(f.get).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
      expect(row(state)).toBeUndefined();
    });
  },
);

it("pins the source across new challenges, storage eviction and configured source changes", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await fixture(state, instance).verify();
  });
  await evictDurableObject(control());
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await control().attestDatabaseRestoreD1(epoch, id, c);
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      inventory: new R2S3Inventory({ ...inventoryEnv, R2_INVENTORY_BUCKET: "other-bucket" }),
    });
    await expect(
      f.service.verify(epoch, id, c, { ...source, bucket: "other-bucket" }),
    ).rejects.toThrow(/blobs_conflict/);
    expect(f.get).not.toHaveBeenCalled();
    expect(row(state)?.source_json).toBe(JSON.stringify(source));
  });
});

it.each(["stale", "unverified", "cancelled", "expired", "backward"])(
  "refuses %s D1 authority before probe dispatch",
  async (kind) => {
    if (kind === "stale" || kind === "unverified") {
      const next = await control().challengeDatabaseRestoreD1(epoch, id, target);
      if (kind === "unverified") c = next;
    }
    if (kind === "cancelled") await control().cancelDatabaseRestore(epoch, id);
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "expired" || kind === "backward")
        vi.spyOn(Date, "now").mockReturnValue(kind === "expired" ? c.expiresAt : c.issuedAt - 1);
      const f = fixture(state, instance);
      await expect(f.verify()).rejects.toThrow(/database_restore_/);
      expect(f.get).not.toHaveBeenCalled();
      expect(row(state)).toBeUndefined();
    });
  },
);

it.each(["get", "put", "s3"] as const)(
  "stops after cancellation during %s without dispatching the next operation",
  async (stage) => {
    await runInDurableObject(control(), async (instance, state) => {
      const cancel = () => {
        new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
      };
      const f = fixture(state, instance, {
        [stage]: async () => {
          const r = stage === "s3" ? await readS3() : undefined;
          cancel();
          return r;
        },
      });
      await expect(f.verify()).rejects.toThrow(/database_restore_not_preparing/);
      expect(f.get).toHaveBeenCalledOnce();
      expect(f.put).toHaveBeenCalledTimes(stage === "get" ? 0 : 1);
      expect(f.transport).toHaveBeenCalledTimes(stage === "s3" ? 1 : 0);
      expect(row(state)?.verified_at).toBeNull();
    });
  },
);

it.each([1, 2, 3])(
  "fences a D1-only stop revision change while waiting for external call %i",
  async (nth) => {
    await runInDurableObject(control(), async (instance, state) => {
      let calls = 0;
      const mutations: BindingVerificationSource = {
        DB: env.DB,
        systemControl: {
          beginR2Write: (request) => instance.beginR2Write(request),
          finishR2Write: (grant, outcome) => instance.finishR2Write(grant, outcome),
          status: () => instance.status(),
          acquireGlobalMutation: async (request) => {
            const grant = await instance.acquireGlobalMutation(request);
            if (request.permitId.startsWith("global:r2.probe-call:") && ++calls === nth)
              await env.DB.prepare(
                "UPDATE control SET admission_revision=admission_revision+1",
              ).run();
            return grant;
          },
        },
      };
      const f = fixture(state, instance, { mutations });
      await expect(f.verify()).rejects.toThrow();
      expect(f.get).toHaveBeenCalledTimes(nth > 1 ? 1 : 0);
      expect(f.put).toHaveBeenCalledTimes(nth > 2 ? 1 : 0);
      expect(f.transport).not.toHaveBeenCalled();
      expect(row(state)?.verified_at).toBeNull();
    });
  },
);

it.each([1, 2, 3])("a lost external-call budget ACK %i never permits dispatch", async (nth) => {
  await runInDurableObject(control(), async (instance, state) => {
    const fault = systemMutationFault("global:r2.probe-call:", "ack", nth);
    const f = fixture(state, instance, { db: fault.db });
    await expect(f.verify()).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(f.get).toHaveBeenCalledTimes(nth > 1 ? 1 : 0);
    expect(f.put).toHaveBeenCalledTimes(nth > 2 ? 1 : 0);
    expect(f.transport).not.toHaveBeenCalled();
    expect(row(state)?.verified_at).toBeNull();
    expect(await probe()).toMatchObject({ allocated_bytes: 64, lease_token: expect.any(String) });
  });
});

it("rejects a stale or wrong bucket value and invalidates an earlier success before retry", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await fixture(state, instance).verify();
    const oldNonce = (await probe())!.nonce as string;
    const f = fixture(state, instance, { s3: async () => new Response(oldNonce) });
    await expect(f.verify()).rejects.toThrow(/r2_binding_mismatch/);
    expect(row(state)?.verified_at).toBeNull();
    expect(await probe()).toMatchObject({
      allocated_bytes: 64,
      phase: "failed",
      lease_token: expect.any(String),
    });
  });
});

it("rejects stop changes after the S3 read and does not persist a completed observation", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      s3: async () => {
        const response = await readS3();
        state.storage.sql.exec("UPDATE control_admission SET revision=revision+1");
        return response;
      },
    });
    await expect(f.verify()).rejects.toThrow(/target_conflict/);
    expect(row(state)?.verified_at).toBeNull();
  });
});

it.each(["ABORT", "IGNORE"])(
  "does not report success when local persistence fails with %s",
  async (failure) => {
    await runInDurableObject(control(), async (instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER fail_blobs BEFORE UPDATE OF verified_at ON control_database_restore_blobs
      WHEN NEW.verified_at IS NOT NULL BEGIN SELECT RAISE(${failure}${failure === "ABORT" ? ",'disk_test'" : ""}); END`);
      await expect(fixture(state, instance).verify()).rejects.toThrow(/disk_test|blobs_conflict/);
      expect(row(state)?.verified_at).toBeNull();
      expect(await probe()).toMatchObject({ phase: "idle" });
      state.storage.sql.exec("DROP TRIGGER fail_blobs");
      expect(await fixture(state, instance).verify()).toMatchObject({ state: "blobs_verified" });
    });
  },
);

it("does not replace a newer observation when the clock moves backward", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance),
      saved = await f.verify();
    f.get.mockClear();
    vi.spyOn(Date, "now").mockReturnValue(saved.verifiedAt - 1);
    await expect(f.verify()).rejects.toThrow(/blobs_conflict|target_expired/);
    expect(row(state)?.verified_at).toBe(saved.verifiedAt);
    expect(f.get).not.toHaveBeenCalled();
  });
});

it("times out a delayed R2 GET, keeps the lease, and blocks all late continuations", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture(state, instance, {
      get: async () => {
        entered();
        await gate;
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const failed = expect(f.verify()).rejects.toThrow(/blobs_timeout/);
      await started;
      await expect(f.verify()).rejects.toThrow(/blobs_busy/);
      await vi.advanceTimersByTimeAsync(25000);
      await failed;
      release();
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      release();
      vi.useRealTimers();
    }
    expect(f.put).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(row(state)?.verified_at).toBeNull();
    expect(await probe()).toMatchObject({ allocated_bytes: 64, lease_token: expect.any(String) });
  });
});

it("rechecks the pinned attempt after awaits and rejects stale epochs/noncanonical objects", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.verifyDatabaseRestoreBlobs(epoch + 1, id, c, source)).rejects.toThrow(
      /epoch_conflict/,
    );
    const f = fixture(state, instance, {
      get: async () => {
        state.storage.sql.exec(
          "UPDATE control_database_restore_blobs SET attempt_id=?",
          crypto.randomUUID(),
        );
      },
    });
    await expect(f.verify()).rejects.toThrow(/blobs_conflict/);
    expect(f.put).not.toHaveBeenCalled();
  });
  const other = env.CONTROL.get(env.CONTROL.idFromName("wrong"));
  await runInDurableObject(other, async (instance) => {
    await expect(instance.verifyDatabaseRestoreBlobs(epoch, id, c, source)).rejects.toThrow(
      /control_singleton_required/,
    );
  });
});
