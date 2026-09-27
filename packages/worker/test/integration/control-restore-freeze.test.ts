import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import type { RestoreFreezeInput } from "../../src/do/controlRestoreFreeze";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { inventoryEnv } from "../fixtures/s3Inventory";

const targets = {
  target: {
    mode: "remote" as const,
    accountId: "a".repeat(32),
    databaseId: "00000000-0000-0000-0000-000000000000",
  },
  blobs: { accountId: "a".repeat(32), bucket: "test-blobs", jurisdiction: "default" as const },
  backups: { accountId: "a".repeat(32), bucket: "test-backups", jurisdiction: "default" as const },
};
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const selected = { kind: "time_travel" as const, bookmark: "opaque" };
let epoch: number, id: string, input: RestoreFreezeInput;
const mirror = () => env.DB.prepare("SELECT * FROM control").first<Record<string, unknown>>();
const freezeRow = (state: DurableObjectState) =>
  state.storage.sql
    .exec("SELECT * FROM control_database_restore_freeze WHERE id=?", id)
    .toArray()[0];
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await env.DB.prepare("DELETE FROM job_leases").run();
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, selected);
  const challenge = await control().challengeDatabaseRestoreD1(epoch, id, targets.target);
  await control().attestDatabaseRestoreD1(epoch, id, challenge);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body),
  );
  input = await runInDurableObject(control(), async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    const blobs = await configured.verifyDatabaseRestoreBlobs(epoch, id, challenge, targets.blobs);
    const backups = await configured.challengeDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      targets.backups,
    );
    const nonce = await (await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY))!.text();
    await configured.attestDatabaseRestoreBackups(epoch, id, challenge, backups.attemptId, nonce);
    return { challenge, blobsAttempt: blobs.attemptId, backupsAttempt: backups.attemptId };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Inject exactly one real query/batch boundary; preserve D1 statements and their bindings. */
function fault(
  options: {
    beforeBatch?: () => Promise<void>;
    afterBatch?: () => Promise<void>;
    afterFirst?: (sql: string) => Promise<void>;
  } = {},
): D1Database {
  return {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (key === "first")
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(target.first, target, args);
                await options.afterFirst?.(sql);
                return result;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      await options.beforeBatch?.();
      const result = await env.DB.batch(statements);
      await options.afterBatch?.();
      return result;
    },
  } as D1Database;
}

it("freezes writes durably, reconciles after eviction, and cancels with a fresh closed token", async () => {
  const before = await mirror();
  const result = await control().freezeDatabaseRestore(epoch, id, targets, input);
  expect(result).toMatchObject({ state: "frozen", validator: "d1-write-freeze-v1", targets });
  expect(result).not.toHaveProperty("token");
  await expect(env.DB.prepare("UPDATE control SET updated_at=updated_at+1").run()).rejects.toThrow(
    /database_restore_frozen/,
  );
  await evictDurableObject(control());
  expect(await control().freezeDatabaseRestore(epoch, id, targets)).toEqual(result);
  expect(await control().prepareDatabaseRestore(epoch, id, selected)).toMatchObject({
    state: "frozen",
  });
  expect(await control().cancelDatabaseRestore(epoch, id)).toMatchObject({ state: "cancelled" });
  const after = await mirror();
  expect(after).toMatchObject({ epoch, maintenance: 1, gc_paused: 1, restore_freeze_token: null });
  expect(after?.admission_revision).toBe(Number(before?.admission_revision) + 1);
  expect(after?.admission_token).not.toBe(before?.admission_token);
  await runInDurableObject(control(), async (instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM recovery_audit_v7").toArray()).toEqual([]);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
    await instance.beginRecoveryAudit(epoch);
    for (let i = 0; i < 20; i++)
      if ((await instance.nextRecoveryAuditPage(epoch, 20)).completed) break;
    expect(await instance.resumeAdmission(epoch)).toMatchObject({
      maintenance: false,
      gcPaused: true,
    });
  });
});

it.each(["global", "repair", "quiesce", "challenge", "resume", "epoch", "backup"])(
  "rejects %s work throughout the frozen state",
  async (kind) => {
    await control().freezeDatabaseRestore(epoch, id, targets, input);
    await runInDurableObject(control(), async (instance) => {
      const actions: Record<string, () => Promise<unknown>> = {
        global: () =>
          instance.acquireGlobalMutation({
            epoch,
            deadline: Date.now() + 5000,
            permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
          }),
        repair: () => instance.repairKdfSettlements(epoch),
        quiesce: () => instance.quiesce(epoch),
        challenge: () => instance.challengeDatabaseRestoreD1(epoch, id, targets.target),
        resume: () => instance.resumeAdmission(epoch),
        epoch: () => instance.bumpEpoch(epoch, "operator"),
        backup: () => instance.beginBackup(epoch, crypto.randomUUID()),
      };
      await expect(actions[kind]!()).rejects.toThrow();
    });
    expect(await control().status()).toMatchObject({ maintenance: true, gcPaused: true });
  },
);

it.each(["kdf", "maintenance", "mutation", "r2-local", "r2-d1"])(
  "keeps ordinary preparation repairable when %s is unfinished",
  async (kind) => {
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "kdf")
        state.storage.sql.exec(
          "INSERT INTO control_kdf_receipts VALUES(?,?,?,?,'reserved')",
          crypto.randomUUID(),
          crypto.randomUUID(),
          epoch,
          Date.now() + 5000,
        );
      if (kind === "maintenance")
        state.storage.sql.exec(
          "INSERT INTO control_maintenance_tasks VALUES(?,?)",
          crypto.randomUUID(),
          epoch,
        );
      if (kind === "mutation")
        await instance.acquireGlobalMutation({
          epoch,
          deadline: Date.now() + 5000,
          permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
        });
      if (kind === "r2-local")
        state.storage.sql.exec(
          "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
          crypto.randomUUID(),
          crypto.randomUUID(),
          "{}",
        );
      if (kind === "r2-d1") {
        // Simulate an outstanding native grant whose local storage was lost before quiesce.
        const now = Date.now();
        await env.DB.prepare("UPDATE control SET maintenance=0").run();
        await env.DB.prepare(
          "INSERT INTO r2_write_attempts VALUES(?,?,?,'fixture','manifest.put',?,?,?,'pending',NULL)",
        )
          .bind(
            crypto.randomUUID(),
            crypto.randomUUID(),
            epoch,
            `target-sets/${crypto.randomUUID()}`,
            now + 5000,
            now,
          )
          .run();
        await env.DB.prepare("UPDATE control SET maintenance=1").run();
      }
      await expect(instance.freezeDatabaseRestore(epoch, id, targets, input)).rejects.toThrow();
      expect(freezeRow(state)).toBeUndefined();
      await expect(instance.inspectDatabaseRestore(epoch, id)).resolves.toMatchObject({
        state: "preparing",
      });
      if (kind === "r2-d1")
        await env.DB.prepare(
          "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE state='pending'",
        ).run();
    });
  },
);

it.each(["attempt", "target", "expired", "cancelled"])(
  "rejects %s proof before taking a durable hold",
  async (kind) => {
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "attempt") input = { ...input, backupsAttempt: crypto.randomUUID() };
      if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(input.challenge.expiresAt);
      if (kind === "cancelled") await instance.cancelDatabaseRestore(epoch, id);
      const changed =
        kind === "target"
          ? { ...targets, backups: { ...targets.backups, bucket: "other-bucket" } }
          : targets;
      await expect(instance.freezeDatabaseRestore(epoch, id, changed, input)).rejects.toThrow();
      expect(freezeRow(state)).toBeUndefined();
    });
  },
);

it.each(["freeze", "cancel"])(
  "recovers a committed %s after lost D1 acknowledgement",
  async (kind) => {
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "cancel") await instance.freezeDatabaseRestore(epoch, id, targets, input);
      const custom = new ControlDO(state, {
        ...env,
        DB: fault({
          afterBatch: async () => {
            throw new Error("lost_ack");
          },
        }),
      });
      const result =
        kind === "freeze"
          ? await custom.freezeDatabaseRestore(epoch, id, targets, input)
          : await custom.cancelDatabaseRestore(epoch, id);
      expect(result.state).toBe(kind === "freeze" ? "frozen" : "cancelled");
    });
  },
);

it("holds an unconfirmed freeze across eviction and retries the same identity", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        beforeBatch: async () => {
          throw new Error("unavailable");
        },
      }),
    });
    await expect(custom.freezeDatabaseRestore(epoch, id, targets, input)).rejects.toThrow(
      /unconfirmed/,
    );
    expect(freezeRow(state)?.phase).toBe("freezing");
    await expect(custom.repairKdfSettlements(epoch)).rejects.toThrow(/frozen/);
  });
  await evictDurableObject(control());
  expect(await control().freezeDatabaseRestore(epoch, id, targets)).toMatchObject({
    state: "frozen",
  });
});

it("refuses a changed retry target before reading or changing D1", async () => {
  await control().freezeDatabaseRestore(epoch, id, targets, input);
  await runInDurableObject(control(), async (_instance, state) => {
    const prepare = vi.fn(() => {
      throw new Error("must_not_read");
    });
    const custom = new ControlDO(state, { ...env, DB: { prepare } as unknown as D1Database });
    await expect(
      custom.freezeDatabaseRestore(epoch, id, {
        ...targets,
        blobs: { ...targets.blobs, bucket: "changed" },
      }),
    ).rejects.toThrow(/target_mismatch/);
    expect(prepare).not.toHaveBeenCalled();
  });
});

it("cancels a delayed freeze and fences its later D1 batch", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        beforeBatch: async () => {
          entered();
          await gate;
        },
      }),
    });
    const pending = expect(custom.freezeDatabaseRestore(epoch, id, targets, input)).rejects.toThrow(
      /conflict/,
    );
    await started;
    await instance.cancelDatabaseRestore(epoch, id);
    release();
    await pending;
    expect(await mirror()).toMatchObject({
      restore_freeze_token: null,
      admission_revision: input.challenge.revision + 1,
    });
    expect(freezeRow(state)?.phase).toBe("cancelled");
  });
});

it("rejects a queued repair admission after its D1 observation resumes behind the freeze", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let release!: () => void,
      entered!: () => void,
      fired = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        afterFirst: async (sql) => {
          if (!fired && sql.includes("SELECT 1 FROM control WHERE")) {
            fired = true;
            entered();
            await gate;
          }
        },
      }),
    });
    const permitId = "global:r2.probe-phase:" + crypto.randomUUID();
    const pending = expect(
      custom.acquireGlobalMutation({ epoch, deadline: Date.now() + 5000, permitId }),
    ).rejects.toThrow(/mutation_unavailable/);
    await started;
    await instance.freezeDatabaseRestore(epoch, id, targets, input);
    release();
    await pending;
    expect(
      await env.DB.prepare("SELECT 1 FROM mutation_admissions WHERE permit_id=?")
        .bind(permitId)
        .first(),
    ).toBeNull();
  });
});

it("rechecks D1 drain in the freeze transaction after a stale successful preflight", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let fired = false;
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        afterFirst: async (sql) => {
          if (!fired && sql.includes("SELECT 1 FROM control c")) {
            fired = true;
            await instance.acquireGlobalMutation({
              epoch,
              deadline: Date.now() + 5000,
              permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
            });
          }
        },
      }),
    });
    await expect(custom.freezeDatabaseRestore(epoch, id, targets, input)).rejects.toThrow(
      /unconfirmed/,
    );
    expect(fired).toBe(true);
    expect(freezeRow(state)?.phase).toBe("freezing");
    expect((await mirror())?.restore_freeze_token).toBeNull();
    expect(await instance.cancelDatabaseRestore(epoch, id)).toMatchObject({ state: "cancelled" });
  });
});

it("keeps an expired unconfirmed freeze cancellable without renewing its binding proofs", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        beforeBatch: async () => {
          throw new Error("unavailable");
        },
      }),
    });
    await expect(custom.freezeDatabaseRestore(epoch, id, targets, input)).rejects.toThrow(
      /unconfirmed/,
    );
    vi.spyOn(Date, "now").mockReturnValue(Number(freezeRow(state)?.expires_at));
    await expect(instance.freezeDatabaseRestore(epoch, id, targets)).rejects.toThrow(/conflict/);
    expect(await instance.cancelDatabaseRestore(epoch, id)).toMatchObject({ state: "cancelled" });
    expect((await mirror())?.restore_freeze_token).toBeNull();
  });
});

it("does not recreate a frozen marker that disappeared from D1", async () => {
  await control().freezeDatabaseRestore(epoch, id, targets, input);
  // Simulate external D1 change; this is not the supported cancellation flow.
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.freezeDatabaseRestore(epoch, id, targets)).rejects.toThrow(/conflict/);
    expect(freezeRow(state)?.phase).toBe("frozen");
    expect((await mirror())?.restore_freeze_token).toBeNull();
  });
});

it("times out a delayed freeze while retaining the intent and fences its late continuation", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const custom = new ControlDO(state, {
      ...env,
      DB: fault({
        beforeBatch: async () => {
          entered();
          await gate;
        },
      }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = expect(
        custom.freezeDatabaseRestore(epoch, id, targets, input),
      ).rejects.toThrow(/freeze_timeout/);
      await started;
      await vi.advanceTimersByTimeAsync(25000);
      await pending;
      expect(freezeRow(state)?.phase).toBe("freezing");
      const completed = await instance.freezeDatabaseRestore(epoch, id, targets);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(completed.state).toBe("frozen");
      expect(freezeRow(state)?.phase).toBe("frozen");
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});

it.each([
  "proof ABORT",
  "proof IGNORE",
  "cancel ABORT",
  "cancel IGNORE",
  "request IGNORE",
  "admission IGNORE",
])("retains the hold on local %s and recovers on retry", async (failure) => {
  await runInDurableObject(control(), async (instance, state) => {
    const [kind, behavior] = failure.split(" ");
    if (kind !== "proof") await instance.freezeDatabaseRestore(epoch, id, targets, input);
    const table =
      kind === "request"
        ? "control_database_restore"
        : kind === "admission"
          ? "control_admission"
          : "control_database_restore_freeze";
    const condition =
      kind === "proof"
        ? "NEW.phase='frozen'"
        : kind === "cancel" || kind === "request"
          ? "NEW.phase='cancelled'"
          : "NEW.revision<>OLD.revision";
    state.storage.sql.exec(
      `CREATE TRIGGER fail_freeze BEFORE UPDATE ON ${table} WHEN ${condition} BEGIN SELECT RAISE(${behavior}${behavior === "ABORT" ? ",'disk_test'" : ""}); END`,
    );
    await expect(
      kind === "proof"
        ? instance.freezeDatabaseRestore(epoch, id, targets, input)
        : instance.cancelDatabaseRestore(epoch, id),
    ).rejects.toThrow(/conflict|disk_test/);
    expect(freezeRow(state)?.phase).toBe(kind === "proof" ? "freezing" : "cancelling");
    state.storage.sql.exec("DROP TRIGGER fail_freeze");
    expect(
      (kind === "proof"
        ? await instance.freezeDatabaseRestore(epoch, id, targets)
        : await instance.cancelDatabaseRestore(epoch, id)
      ).state,
    ).toBe(kind === "proof" ? "frozen" : "cancelled");
  });
});
