import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_D1_QUERY, RESTORE_D1_WINDOW_MS } from "../../../shared/src/restoreTarget";
import { CONTROL_NAME, type ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreTarget } from "../../src/do/controlRestoreTarget";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const target = { mode: "local" as const, databaseId: "00000000-0000-0000-0000-000000000000" };
let epoch: number, id: string;
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
  id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
});
afterEach(() => vi.restoreAllMocks());
const challenge = () => control().challengeDatabaseRestoreD1(epoch, id, target);
const attest = (value: Awaited<ReturnType<typeof challenge>>) =>
  control().attestDatabaseRestoreD1(epoch, id, value);
const mirror = () => env.DB.prepare(RESTORE_D1_QUERY).first();
// Vitest's direct RPC wrapper can report expected rejections as unhandled. Catch inside the DO.
async function refuse(call: (instance: ControlDO) => Promise<unknown>, error: RegExp) {
  await runInDurableObject(control(), async (instance) => {
    await expect(call(instance)).rejects.toThrow(error);
  });
}
function authority(state: DurableObjectState) {
  return state.storage.sql
    .exec<{ epoch: number; revision: number; token: string }>(
      "SELECT epoch,revision,token FROM control_admission WHERE phase='closed'",
    )
    .one();
}
function proof(state: DurableObjectState) {
  return state.storage.sql
    .exec("SELECT * FROM control_database_restore_target WHERE id=?", id)
    .one();
}
function service(
  state: DurableObjectState,
  db = env.DB,
  close: () => Promise<unknown> = async () => {
    throw new Error("test_unexpected_close");
  },
) {
  return new ControlRestoreTarget(
    state.storage.sql,
    db,
    new ControlDatabaseRestore(state.storage.sql),
    () => authority(state),
    close,
  );
}
function dbAfterRead(effect: () => Promise<void>): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => {
        const result = await env.DB.prepare(sql).all();
        await effect();
        return result;
      },
    }),
  } as unknown as D1Database;
}

it("renews the D1 stop token and persists a bounded observation across eviction", async () => {
  const before = await mirror(),
    c = await challenge();
  expect(c.token).not.toBe(before!.admission_token);
  expect(c.revision).toBeGreaterThan(before!.admission_revision as number);
  expect(c.expiresAt - c.issuedAt).toBe(RESTORE_D1_WINDOW_MS);
  expect(await mirror()).toMatchObject({
    admission_token: c.token,
    admission_revision: c.revision,
    epoch,
    maintenance: 1,
    gc_paused: 1,
  });
  await evictDurableObject(control());
  const result = await attest(c);
  expect(result).toMatchObject({
    id,
    epoch,
    target,
    state: "d1_verified",
    challengeId: c.challengeId,
    validator: "d1-mirror-v1",
  });
  expect(result).not.toHaveProperty("token");
  await evictDurableObject(control());
  await runInDurableObject(control(), async (_instance, state) => {
    expect(proof(state)).toMatchObject({
      target_json: JSON.stringify(target),
      verified_at: result.verifiedAt,
      token: c.token,
    });
  });
  expect((await attest(c)).verifiedAt).toBeGreaterThanOrEqual(result.verifiedAt);
  expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow(/database_restore_active/);
  });
});

it("pins the target and refuses a different DB or mode without rotating the current challenge", async () => {
  const c = await challenge();
  for (const different of [
    { ...target, databaseId: crypto.randomUUID() },
    { ...target, mode: "remote" as const, accountId: "a".repeat(32) },
  ])
    await refuse(
      (instance) => instance.challengeDatabaseRestoreD1(epoch, id, different),
      /database_restore_target_conflict/,
    );
  expect(await attest(c)).toMatchObject({ challengeId: c.challengeId });
});

it("invalidates old evidence on every new challenge including a retry after lost acknowledgement", async () => {
  const old = await challenge();
  await attest(old);
  const next = await challenge();
  expect(next.challengeId).not.toBe(old.challengeId);
  expect(next.token).not.toBe(old.token);
  await refuse(
    (instance) => instance.attestDatabaseRestoreD1(epoch, id, old),
    /database_restore_target_conflict/,
  );
  await runInDurableObject(control(), async (_instance, state) => {
    expect(proof(state).verified_at).toBeNull();
  });
  expect(await attest(next)).toMatchObject({ challengeId: next.challengeId });
});

it("keeps the target pinned if the stop fails before a challenge can be published", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const s = service(state, env.DB, async () => {
      throw new Error("lost_stop_response");
    });
    await expect(s.challenge(epoch, id, target)).rejects.toThrow("lost_stop_response");
    expect(proof(state)).toMatchObject({
      target_json: JSON.stringify(target),
      revision: null,
      verified_at: null,
    });
  });
  await evictDurableObject(control());
  await refuse(
    (instance) =>
      instance.challengeDatabaseRestoreD1(epoch, id, {
        ...target,
        databaseId: crypto.randomUUID(),
      }),
    /target_conflict/,
  );
  expect(await attest(await challenge())).toMatchObject({ state: "d1_verified" });
});

it.each(["epoch", "revision", "token", "challengeId", "expiresAt", "target"] as const)(
  "rejects altered %s in operator attestations",
  async (field) => {
    const c = await challenge();
    const changed = {
      ...c,
      [field]:
        field === "target"
          ? { ...target, databaseId: crypto.randomUUID() }
          : typeof c[field] === "number"
            ? (c[field] as number) + 1
            : crypto.randomUUID(),
    };
    await refuse(
      (instance) => instance.attestDatabaseRestoreD1(epoch, id, changed),
      /database_restore_(invalid_challenge|target_conflict)/,
    );
    await runInDurableObject(control(), async (_instance, state) => {
      expect(proof(state).verified_at).toBeNull();
    });
  },
);

it("requires the exact fresh D1 mirror even when old verified evidence exists", async () => {
  const c = await challenge();
  const saved = await attest(c);
  await env.DB.prepare("UPDATE control SET admission_token=? WHERE singleton=1")
    .bind(crypto.randomUUID())
    .run();
  await refuse(
    (instance) => instance.attestDatabaseRestoreD1(epoch, id, c),
    /database_restore_target_mismatch/,
  );
  await runInDurableObject(control(), async (_instance, state) => {
    expect(proof(state).verified_at).toBe(saved.verifiedAt);
  });
});

it("does not accept a receipt read while cancellation completes", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (_instance, state) => {
    const s = service(
      state,
      dbAfterRead(async () => {
        new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
      }),
    );
    await expect(s.attest(epoch, id, c)).rejects.toThrow(/database_restore_not_preparing/);
    expect(proof(state).verified_at).toBeNull();
  });
  await refuse(
    (instance) => instance.challengeDatabaseRestoreD1(epoch, id, target),
    /database_restore_not_preparing/,
  );
});

it("does not accept an old D1 read after the local admission revision changes", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (_instance, state) => {
    const s = service(
      state,
      dbAfterRead(async () => {
        state.storage.sql.exec("UPDATE control_admission SET revision=revision+1");
      }),
    );
    await expect(s.attest(epoch, id, c)).rejects.toThrow(/database_restore_target_conflict/);
    expect(proof(state).verified_at).toBeNull();
  });
});

it.each(["expired", "backward"])(
  "rejects a %s server clock before and after a D1 read",
  async (mode) => {
    const c = await challenge();
    const invalid = mode === "expired" ? c.expiresAt : c.issuedAt - 1;
    await runInDurableObject(control(), async (_instance, state) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(invalid);
      await expect(service(state).attest(epoch, id, c)).rejects.toThrow(
        /database_restore_target_expired/,
      );
      clock.mockReturnValue(c.issuedAt);
      const s = service(
        state,
        dbAfterRead(async () => {
          clock.mockReturnValue(invalid);
        }),
      );
      await expect(s.attest(epoch, id, c)).rejects.toThrow(/database_restore_target_expired/);
      expect(proof(state).verified_at).toBeNull();
    });
  },
);

it("retains the prior proof after storage failure and permits a fresh read on retry", async () => {
  const c = await challenge();
  const saved = await attest(c);
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER reject_target BEFORE UPDATE ON control_database_restore_target BEGIN SELECT RAISE(ABORT,'disk_test'); END",
    );
    await expect(service(state).attest(epoch, id, c)).rejects.toThrow(/disk_test/);
    expect(proof(state).verified_at).toBe(saved.verifiedAt);
    state.storage.sql.exec("DROP TRIGGER reject_target");
    expect((await service(state).attest(epoch, id, c)).verifiedAt).toBeGreaterThanOrEqual(
      saved.verifiedAt,
    );
  });
});

it("rejects stale epochs and a noncanonical ControlDO", async () => {
  await refuse(
    (instance) => instance.challengeDatabaseRestoreD1(epoch + 1, id, target),
    /database_restore_epoch_conflict/,
  );
  const other = env.CONTROL.get(env.CONTROL.idFromName("wrong"));
  await runInDurableObject(other, async (instance) => {
    await expect(instance.challengeDatabaseRestoreD1(epoch, id, target)).rejects.toThrow(
      /control_singleton_required/,
    );
  });
});

it("refuses to issue a challenge if the supposed stop did not rotate admission", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    await expect(
      service(state, env.DB, async () => {}).challenge(epoch, id, target),
    ).rejects.toThrow(/database_restore_target_conflict/);
    expect(proof(state)).toMatchObject({ revision: null, token: null, verified_at: null });
  });
});

it("does not adopt a rolled-back D1 mirror when issuing a challenge", async () => {
  const old = await mirror();
  await challenge();
  await env.DB.prepare(
    "UPDATE control SET admission_revision=?,admission_token=? WHERE singleton=1",
  )
    .bind(old!.admission_revision, old!.admission_token)
    .run();
  await refuse(
    (instance) => instance.challengeDatabaseRestoreD1(epoch, id, target),
    /database_restore_mirror_conflict/,
  );
  await runInDurableObject(control(), async (_instance, state) => {
    expect(proof(state)).toMatchObject({ revision: null, token: null, verified_at: null });
  });
});

it("keeps an in-flight observation exclusive and rejects a replaced challenge after readback", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (_instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const s = service(
      state,
      dbAfterRead(async () => {
        entered();
        await gate;
      }),
    );
    const pending = s.attest(epoch, id, c);
    await started;
    await expect(s.attest(epoch, id, c)).rejects.toThrow(/database_restore_target_busy/);
    await expect(s.challenge(epoch, id, target)).rejects.toThrow(/database_restore_target_busy/);
    state.storage.sql.exec(
      "UPDATE control_database_restore_target SET challenge_id=? WHERE id=?",
      crypto.randomUUID(),
      id,
    );
    const rejected = expect(pending).rejects.toThrow(/database_restore_target_conflict/);
    release();
    await rejected;
    expect(proof(state).verified_at).toBeNull();
  });
});

it("preserves a newer verification time when the server clock steps backward within the window", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (_instance, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(c.issuedAt + 10),
      s = service(state);
    const saved = await s.attest(epoch, id, c);
    clock.mockReturnValue(c.issuedAt + 5);
    await expect(s.attest(epoch, id, c)).rejects.toThrow(/database_restore_target_expired/);
    await expect(s.challenge(epoch, id, target)).rejects.toThrow(
      /database_restore_target_conflict/,
    );
    expect(proof(state).verified_at).toBe(saved.verifiedAt);
  });
});

it("does not return success when storage ignores the attestation update", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER ignore_target BEFORE UPDATE ON control_database_restore_target BEGIN SELECT RAISE(IGNORE); END",
    );
    try {
      await expect(service(state).attest(epoch, id, c)).rejects.toThrow(
        /database_restore_target_conflict/,
      );
      expect(proof(state).verified_at).toBeNull();
    } finally {
      state.storage.sql.exec("DROP TRIGGER ignore_target");
    }
  });
});

it("does not publish a challenge if the request is cancelled during the stop", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const s = service(state, env.DB, async () => {
      new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
    });
    await expect(s.challenge(epoch, id, target)).rejects.toThrow(/database_restore_not_preparing/);
    expect(proof(state)).toMatchObject({ revision: null, token: null, verified_at: null });
  });
});
