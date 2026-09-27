import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  RESTORE_BACKUPS_PROBE_KEY as KEY,
  RESTORE_BACKUPS_PROBE_KIND as KIND,
} from "../../../shared/src/restoreBackups";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreBackups } from "../../src/do/controlRestoreBackups";
import { ControlRestoreTarget } from "../../src/do/controlRestoreTarget";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const target = {
  mode: "remote" as const,
  databaseId: "00000000-0000-0000-0000-000000000000",
  accountId: "a".repeat(32),
};
const source = {
  accountId: target.accountId,
  bucket: "test-backups",
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
  // Test isolation only. Production never removes its permanent probe.
  await env.BACKUPS.delete(KEY);
  epoch = (await control().recover()).epoch;
  id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await control().attestDatabaseRestoreD1(epoch, id, c);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const nonce = async () => (await env.BACKUPS.get(KEY))!.text();
const row = (state: DurableObjectState) =>
  state.storage.sql
    .exec("SELECT * FROM control_database_restore_backups WHERE id=?", id)
    .toArray()[0];
const slot = (state: DurableObjectState) =>
  state.storage.sql.exec("SELECT * FROM control_restore_backups_probe").toArray()[0];

function fixture(
  state: DurableObjectState,
  instance: ControlDO,
  options: {
    get?: () => Promise<void>;
    put?: () => Promise<void>;
    beforePut?: () => Promise<void>;
    db?: D1Database;
    mutations?: GlobalMutationSource;
  } = {},
) {
  const db = options.db ?? env.DB;
  const get = vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
    const value = await env.BACKUPS.get(...args);
    await options.get?.();
    return value;
  });
  const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
    await options.beforePut?.();
    const value = await env.BACKUPS.put(...args);
    await options.put?.();
    return value;
  });
  const verifier = new ControlRestoreTarget(
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
  const service = new ControlRestoreBackups(
    state.storage,
    options.mutations ?? { DB: db, systemControl: instance },
    { get, put } as unknown as R2Bucket,
    verifier,
  );
  return {
    service,
    get,
    put,
    challenge: () => service.challenge(epoch, id, c, source),
    attest: async (attemptId: string, observed?: string) =>
      service.attest(epoch, id, c, attemptId, observed ?? (await nonce())),
  };
}

it("writes a fresh hidden nonce, survives eviction, and attests without exposing secrets", async () => {
  let previous = "";
  for (let i = 0; i < 2; i++) {
    const issued = await control().challengeDatabaseRestoreBackups(epoch, id, c, source);
    expect(issued).toMatchObject({
      id,
      epoch,
      source,
      target,
      state: "backups_challenge",
      challengeId: c.challengeId,
    });
    expect(issued).not.toHaveProperty("nonce");
    expect(issued).not.toHaveProperty("token");
    const value = await nonce();
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toBe(previous);
    previous = value;
    await evictDurableObject(control());
    const result = await control().attestDatabaseRestoreBackups(
      epoch,
      id,
      c,
      issued.attemptId,
      value,
    );
    expect(result).toMatchObject({
      state: "backups_verified",
      validator: "backups-binding-v1",
      attemptId: issued.attemptId,
      expiresAt: issued.expiresAt,
    });
    expect(result).not.toHaveProperty("nonce");
    expect(result).not.toHaveProperty("token");
    await runInDurableObject(control(), async (_instance, state) => {
      expect(row(state)).toMatchObject({ phase: "verified", verified_at: result.verifiedAt });
      expect(slot(state)).toMatchObject({
        allocated_bytes: 64,
        lease_expires_at: 0,
        calls: 3 * (i + 1),
      });
    });
    c = await control().challengeDatabaseRestoreD1(epoch, id, target);
    await control().attestDatabaseRestoreD1(epoch, id, c);
  }
  expect(await control().status()).toMatchObject({ maintenance: true, gcPaused: true });
});

it.each(["nonce", "attempt"])("rejects a wrong %s before rereading BACKUPS", async (kind) => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance),
      issued = await f.challenge();
    f.get.mockClear();
    await expect(
      f.attest(
        kind === "attempt" ? crypto.randomUUID() : issued.attemptId,
        kind === "nonce" ? "0".repeat(64) : await nonce(),
      ),
    ).rejects.toThrow(/backups_mismatch/);
    expect(f.get).not.toHaveBeenCalled();
    expect(row(state)?.verified_at).toBeNull();
    expect(slot(state)).toMatchObject({ allocated_bytes: 64, lease_expires_at: issued.expiresAt });
  });
});

it.each(["cancelled", "stale", "unverified", "expired", "backward", "mirror"])(
  "rejects %s D1 authority before any R2 dispatch",
  async (kind) => {
    if (kind === "cancelled") await control().cancelDatabaseRestore(epoch, id);
    if (kind === "stale" || kind === "unverified") {
      const next = await control().challengeDatabaseRestoreD1(epoch, id, target);
      if (kind === "unverified") c = next;
    }
    if (kind === "mirror")
      await env.DB.prepare("UPDATE control SET admission_revision=admission_revision+1").run();
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "expired" || kind === "backward")
        vi.spyOn(Date, "now").mockReturnValue(kind === "expired" ? c.expiresAt : c.issuedAt - 1);
      const f = fixture(state, instance);
      await expect(f.challenge()).rejects.toThrow(/database_restore_/);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
    });
  },
);

it("pins account/bucket/jurisdiction and rejects a changed target after eviction", async () => {
  const issued = await control().challengeDatabaseRestoreBackups(epoch, id, c, source);
  await control().attestDatabaseRestoreBackups(epoch, id, c, issued.attemptId, await nonce());
  await evictDurableObject(control());
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await control().attestDatabaseRestoreD1(epoch, id, c);
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance);
    for (const changed of [
      { ...source, bucket: "other-bucket" },
      { ...source, jurisdiction: "eu" as const },
      { ...source, accountId: "b".repeat(32) },
    ])
      await expect(f.service.challenge(epoch, id, c, changed)).rejects.toThrow(
        /backups_conflict|backups_target_mismatch/,
      );
    expect(f.get).not.toHaveBeenCalled();
    expect(row(state)?.source_json).toBe(JSON.stringify(source));
  });
});

it.each(["get", "put", "attest"])(
  "cancellation during %s prevents all later operations",
  async (stage) => {
    await runInDurableObject(control(), async (instance, state) => {
      let reads = 0;
      const cancel = () => {
        new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
      };
      const f = fixture(state, instance, {
        get: async () => {
          if (++reads === (stage === "attest" ? 2 : 1) && stage !== "put") cancel();
        },
        put: async () => {
          if (stage === "put") cancel();
        },
      });
      const run = async () => {
        const issued = await f.challenge();
        return f.attest(issued.attemptId);
      };
      await expect(run()).rejects.toThrow(/database_restore_not_preparing/);
      expect(f.put).toHaveBeenCalledTimes(stage === "get" ? 0 : 1);
      expect(row(state)?.verified_at).toBeNull();
    });
  },
);

it.each([1, 2, 3])("requires the direct budget ACK for external call %i", async (nth) => {
  await runInDurableObject(control(), async (instance, state) => {
    const fault = systemMutationFault("global:restore.backups-probe:", "ack", nth),
      f = fixture(state, instance, { db: fault.db });
    await expect(
      (async () => {
        const issued = await f.challenge();
        return f.attest(issued.attemptId);
      })(),
    ).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(f.get).toHaveBeenCalledTimes(nth > 1 ? 1 : 0);
    expect(f.put).toHaveBeenCalledTimes(nth > 2 ? 1 : 0);
    expect(row(state)?.verified_at).toBeNull();
    expect(slot(state)?.allocated_bytes).toBe(64);
  });
});

it.each([1, 2, 3])("fences a D1-only stop change while waiting for call %i", async (nth) => {
  await runInDurableObject(control(), async (instance, state) => {
    let calls = 0;
    const mutations: GlobalMutationSource = {
      DB: env.DB,
      systemControl: {
        status: () => instance.status(),
        acquireGlobalMutation: async (request) => {
          const grant = await instance.acquireGlobalMutation(request);
          if (++calls === nth)
            await env.DB.prepare(
              "UPDATE control SET admission_revision=admission_revision+1",
            ).run();
          return grant;
        },
      },
    };
    const f = fixture(state, instance, { mutations });
    await expect(
      (async () => {
        const issued = await f.challenge();
        return f.attest(issued.attemptId);
      })(),
    ).rejects.toThrow();
    expect(f.get).toHaveBeenCalledTimes(nth > 1 ? 1 : 0);
    expect(f.put).toHaveBeenCalledTimes(nth > 2 ? 1 : 0);
    expect(row(state)?.verified_at).toBeNull();
  });
});

it("retains the allocation and lease after an unknown PUT, and rotates after expiry", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      put: async () => {
        throw new Error("lost_put_ack");
      },
    });
    await expect(f.challenge()).rejects.toThrow(/lost_put_ack/);
    const previous = await nonce();
    expect(row(state)).toMatchObject({ phase: "writing", verified_at: null });
    expect(slot(state)).toMatchObject({ allocated_bytes: 64, calls: 2 });
    await expect(fixture(state, instance).challenge()).rejects.toThrow(/backups_busy/);
    state.storage.sql.exec("UPDATE control_restore_backups_probe SET lease_expires_at=0");
    const retry = fixture(state, instance),
      next = await retry.challenge();
    expect(await nonce()).not.toBe(previous);
    expect(await retry.attest(next.attemptId)).toMatchObject({ state: "backups_verified" });
  });
});

it("rejects replacement of the object even if its nonce was copied", async () => {
  const issued = await control().challengeDatabaseRestoreBackups(epoch, id, c, source),
    value = await nonce();
  await env.BACKUPS.put(KEY, value, { customMetadata: { ncf_kind: KIND } });
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.attestDatabaseRestoreBackups(epoch, id, c, issued.attemptId, value),
    ).rejects.toThrow(/backups_mismatch/);
  });
});

it.each(["proof ABORT", "proof IGNORE", "lease ABORT", "lease IGNORE"])(
  "rolls back both confirmation and lease release on %s",
  async (failure) => {
    await runInDurableObject(control(), async (instance, state) => {
      const f = fixture(state, instance),
        issued = await f.challenge(),
        value = await nonce();
      const [targetTable, action] = failure.split(" "),
        proof = targetTable === "proof";
      state.storage.sql.exec(`CREATE TRIGGER fail_backup_probe BEFORE UPDATE ON ${proof ? "control_database_restore_backups" : "control_restore_backups_probe"}
      WHEN ${proof ? "NEW.verified_at IS NOT NULL" : "NEW.lease_expires_at=0"} BEGIN SELECT RAISE(${action}${action === "ABORT" ? ",'disk_test'" : ""}); END`);
      await expect(f.attest(issued.attemptId, value)).rejects.toThrow(/disk_test|backups_conflict/);
      expect(row(state)).toMatchObject({ phase: "issued", verified_at: null });
      expect(slot(state)?.lease_expires_at).toBe(issued.expiresAt);
      state.storage.sql.exec("DROP TRIGGER fail_backup_probe");
      expect(await f.attest(issued.attemptId, value)).toMatchObject({ state: "backups_verified" });
    });
  },
);

it.each([false, true])(
  "blocks a delayed %s-existing PUT from replacing a later successful generation",
  async (existing) => {
    if (existing)
      await env.BACKUPS.put(KEY, "a".repeat(64), { customMetadata: { ncf_kind: KIND } });
    await runInDurableObject(control(), async (instance, state) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const old = fixture(state, instance, {
        beforePut: async () => {
          entered();
          await gate;
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const failed = expect(old.challenge()).rejects.toThrow(/backups_timeout/);
        await started;
        await expect(old.challenge()).rejects.toThrow(/backups_busy/);
        await vi.advanceTimersByTimeAsync(25000);
        await failed;
        expect(row(state)?.phase).toBe("writing");
        state.storage.sql.exec("UPDATE control_restore_backups_probe SET lease_expires_at=0");
        const next = fixture(state, instance),
          issued = await next.challenge(),
          value = await nonce();
        await next.attest(issued.attemptId, value);
        release();
        await vi.advanceTimersByTimeAsync(1);
        expect(await nonce()).toBe(value);
        expect(row(state)).toMatchObject({ attempt_id: issued.attemptId, phase: "verified" });
      } finally {
        release();
        vi.useRealTimers();
      }
    });
  },
);

it("joins only the current BLOBS and BACKUPS attempts under the same D1 challenge", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body),
  );
  await runInDurableObject(control(), async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    const blobsSource = { ...source, bucket: "test-blobs" };
    const blobs = await configured.verifyDatabaseRestoreBlobs(epoch, id, c, blobsSource),
      backups = await configured.challengeDatabaseRestoreBackups(epoch, id, c, source);
    await expect(
      configured.verifyDatabaseRestoreBindings(epoch, id, c, blobs.attemptId, backups.attemptId),
    ).rejects.toThrow(/backups_conflict/);
    await configured.attestDatabaseRestoreBackups(epoch, id, c, backups.attemptId, await nonce());
    expect(
      await configured.verifyDatabaseRestoreBindings(
        epoch,
        id,
        c,
        blobs.attemptId,
        backups.attemptId,
      ),
    ).toMatchObject({
      state: "bindings_verified",
      challengeId: c.challengeId,
      blobs: { attemptId: blobs.attemptId },
      backups: { attemptId: backups.attemptId },
    });
    await expect(
      configured.verifyDatabaseRestoreBindings(
        epoch,
        id,
        c,
        crypto.randomUUID(),
        backups.attemptId,
      ),
    ).rejects.toThrow(/blobs_conflict/);
    vi.spyOn(Date, "now").mockReturnValue(backups.expiresAt);
    await expect(
      configured.verifyDatabaseRestoreBindings(epoch, id, c, blobs.attemptId, backups.attemptId),
    ).rejects.toThrow(/backups_conflict/);
  });
});
