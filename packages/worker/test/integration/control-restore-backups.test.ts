import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  RESTORE_BACKUPS_PROBE_KEY as KEY,
  RESTORE_BACKUPS_PROBE_KIND as KIND,
} from "../../../shared/src/restoreBackups";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import type { R2WriteGrant, R2WriteRequest, R2WriteTerminal } from "../../src/db/r2Write";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreBackups } from "../../src/do/controlRestoreBackups";
import { ControlRestoreTarget } from "../../src/do/controlRestoreTarget";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence } from "../../src/do/recoveryAudit";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
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
  await clearEndedR2TestWrites();
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
    beforeGrant?: (request: R2WriteRequest) => Promise<void>;
    afterGrant?: (grant: R2WriteGrant) => Promise<void>;
    afterFinish?: (grant: R2WriteGrant, outcome: R2WriteTerminal) => Promise<void>;
  } = {},
) {
  const db = options.db ?? env.DB;
  let request!: R2WriteRequest, grant!: R2WriteGrant;
  const mutations =
    options.mutations && "systemControl" in options.mutations
      ? options.mutations.systemControl
      : instance;
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
    {
      DB: db,
      systemControl: {
        status: () => mutations.status(),
        acquireGlobalMutation: (request) => mutations.acquireGlobalMutation(request),
        beginR2Write: async (input) => {
          request = input;
          await options.beforeGrant?.(input);
          grant = await instance.beginR2Write(input);
          await options.afterGrant?.(grant);
          return grant;
        },
        finishR2Write: async (grant, outcome) => {
          await instance.finishR2Write(grant, outcome);
          await options.afterFinish?.(grant, outcome);
        },
      },
    },
    { get, put } as unknown as R2Bucket,
    verifier,
  );
  return {
    service,
    get,
    put,
    request: () => request,
    grant: () => grant,
    receipt: () =>
      env.DB.prepare("SELECT * FROM r2_write_attempts WHERE id=?").bind(request.id).first(),
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

it("records BACKUPS native dispatch and completion before issuing its challenge", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      beforePut: async () => {
        expect(await f.receipt()).toMatchObject({
          epoch,
          owner_id: null,
          kind: "backups.probe.put",
          r2_key: KEY,
          state: "pending",
          source_ref: JSON.stringify([
            epoch,
            id,
            f.request().backups!.attemptId,
            f.request().backups!.nonce,
          ]),
        });
        expect(row(state)?.phase).toBe("writing");
      },
    });
    const issued = await f.challenge();
    expect(await f.receipt()).toMatchObject({ state: "succeeded" });
    expect(row(state)).toMatchObject({ phase: "issued", attempt_id: issued.attemptId });
    expect(f.put).toHaveBeenCalledOnce();
    await expect(
      instance.beginR2Write({
        ...f.request(),
        id: crypto.randomUUID(),
        deadline: Date.now() + 5000,
      }),
    ).rejects.toThrow();
    expect(state.storage.sql.exec("SELECT * FROM control_r2_write_receipts").toArray()).toEqual([]);
  });
});

it("retains a lost grant reply without sending BACKUPS PUT", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      afterGrant: async () => {
        throw new Error("lost_grant_ack");
      },
    });
    await expect(f.challenge()).rejects.toThrow(/mutation_unavailable/);
    expect(f.put).not.toHaveBeenCalled();
    expect(await f.receipt()).toMatchObject({ state: "pending" });
    expect(row(state)?.phase).toBe("writing");
    await expect(instance.repairR2WriteSettlements(epoch)).resolves.toMatchObject({
      unknown: 1,
      databasePending: 1,
    });
  });
});

it("records not_started when restore is cancelled after receiving the dispatch grant", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      afterGrant: async () => {
        new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
      },
    });
    await expect(f.challenge()).rejects.toThrow(/database_restore_not_preparing/);
    expect(f.put).not.toHaveBeenCalled();
    expect(await f.receipt()).toMatchObject({ state: "not_started" });
  });
});

it.each(["lease", "phase", "nonce", "etag", "source", "attempt", "D1 stop"])(
  "rechecks the original %s while waiting for the BACKUPS write grant",
  async (field) => {
    await runInDurableObject(control(), async (instance, state) => {
      const acquire = instance.acquireGlobalMutation;
      let fired = false;
      vi.spyOn(instance, "acquireGlobalMutation").mockImplementation(async (request) => {
        const admission = await acquire.call(instance, request);
        if (request.permitId.startsWith("global:r2.backups-probe-put:")) {
          fired = true;
          if (field === "D1 stop")
            await env.DB.prepare(
              "UPDATE control SET admission_revision=admission_revision+1",
            ).run();
          else if (field === "lease")
            state.storage.sql.exec("UPDATE control_restore_backups_probe SET lease_expires_at=0");
          else {
            const [column, value] =
              field === "phase"
                ? ["phase", "issued"]
                : field === "nonce"
                  ? ["nonce", "f".repeat(64)]
                  : field === "etag"
                    ? ["etag", "changed-etag"]
                    : field === "source"
                      ? ["source_json", JSON.stringify({ ...source, bucket: "other-backups" })]
                      : ["attempt_id", crypto.randomUUID()];
            state.storage.sql.exec(
              `UPDATE control_database_restore_backups SET ${column}=? WHERE id=?`,
              value,
              id,
            );
          }
        }
        return admission;
      });
      const f = fixture(state, instance);
      await expect(f.challenge()).rejects.toThrow(/mutation_unavailable/);
      expect(fired).toBe(true);
      expect(f.put).not.toHaveBeenCalled();
      if (field === "D1 stop") {
        expect(await f.receipt()).toBeNull();
        expect(
          state.storage.sql
            .exec("SELECT state FROM control_r2_write_receipts WHERE id=?", f.request().id)
            .one(),
        ).toMatchObject({ state: "not_started" });
        // Restore only the injected mirror discrepancy; repair must reuse the saved fact.
        await env.DB.prepare("UPDATE control SET admission_revision=?").bind(c.revision).run();
        await instance.repairR2WriteSettlements(epoch);
      }
      expect(await f.receipt()).toMatchObject({ state: "not_started" });
    });
  },
);

it("settles native completion after cancellation without issuing a stale challenge", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const f = fixture(state, instance, {
      put: async () => {
        new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
      },
    });
    await expect(f.challenge()).rejects.toThrow(/database_restore_not_preparing/);
    expect(f.put).toHaveBeenCalledOnce();
    expect(await f.receipt()).toMatchObject({ state: "succeeded" });
    expect(row(state)).toMatchObject({ phase: "writing", verified_at: null });
  });
});

it.each([25000, 8000])(
  "retains a timed out PUT and settles only its late native completion (%i ms)",
  async (remaining) => {
    await runInDurableObject(control(), async (instance, state) => {
      let release!: () => void, entered!: () => void, finished!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        ended = new Promise<void>((resolve) => {
          finished = resolve;
        });
      if (remaining === 8000) {
        const expiresAt = Date.now() + remaining;
        c = { ...c, issuedAt: expiresAt - 300000, expiresAt };
        state.storage.sql.exec(
          "UPDATE control_database_restore_target SET issued_at=?,expires_at=? WHERE id=?",
          c.issuedAt,
          c.expiresAt,
          id,
        );
      }
      const f = fixture(state, instance, {
        beforePut: async () => {
          entered();
          await gate;
        },
        afterFinish: async () => {
          finished();
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = f.challenge().then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
        await Promise.race([started, result]);
        expect(f.put).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(remaining);
        expect((await result).error?.message).toMatch(/backups_timeout|mutation_unavailable/);
        expect(await f.receipt()).toMatchObject({ state: "pending" });
        release();
        await ended;
        expect(await f.receipt()).toMatchObject({ state: "succeeded" });
        expect(row(state)).toMatchObject({ phase: "writing", verified_at: null });
        expect(f.get).toHaveBeenCalledOnce();
      } finally {
        release();
        vi.useRealTimers();
      }
    });
  },
);

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
    await expect(f.challenge()).rejects.toThrow(/mutation_unavailable/);
    const previous = await nonce();
    expect(row(state)).toMatchObject({ phase: "writing", verified_at: null });
    expect(slot(state)).toMatchObject({ allocated_bytes: 64, calls: 2 });
    expect(await f.receipt()).toMatchObject({
      kind: "backups.probe.put",
      owner_id: null,
      state: "pending",
    });
    await expect(fixture(state, instance).challenge()).rejects.toThrow(/backups_busy/);
    state.storage.sql.exec("UPDATE control_restore_backups_probe SET lease_expires_at=0");
    const retry = fixture(state, instance),
      next = await retry.challenge();
    expect(await nonce()).not.toBe(previous);
    expect(await retry.attest(next.attemptId)).toMatchObject({ state: "backups_verified" });
    expect(await f.receipt()).toMatchObject({ state: "pending" });
    await expect(inspectRecoveryFinalFence(env.DB, epoch)).rejects.toThrow(
      /recovery_final_fence_pending/,
    );
    await expect(env.DB.prepare("UPDATE control SET maintenance=0").run()).rejects.toThrow(
      /r2_write_unsettled/,
    );
    await expect(
      env.DB.prepare("UPDATE control SET restore_freeze_token=?").bind(crypto.randomUUID()).run(),
    ).rejects.toThrow(/restore_freeze_not_drained/);
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
      let release!: () => void, entered!: () => void, finished!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const old = fixture(state, instance, {
        beforePut: async () => {
          entered();
          await gate;
        },
        afterFinish: async () => {
          finished();
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = old.challenge().then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
        await Promise.race([started, result]);
        expect(old.put).toHaveBeenCalledOnce();
        await expect(old.challenge()).rejects.toThrow(/backups_busy/);
        await vi.advanceTimersByTimeAsync(25000);
        expect((await result).error?.message).toMatch(/backups_timeout|mutation_unavailable/);
        expect(row(state)?.phase).toBe("writing");
        state.storage.sql.exec("UPDATE control_restore_backups_probe SET lease_expires_at=0");
        const next = fixture(state, instance),
          issued = await next.challenge(),
          value = await nonce();
        await next.attest(issued.attemptId, value);
        release();
        await settled;
        expect(await old.receipt()).toMatchObject({ state: "succeeded" });
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
