import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import { CONTROL_NAME, type ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreTarget } from "../../src/do/controlRestoreTarget";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";

// Remote identity is synthetic; the D1/DO storage and RPC execution are local workerd.
const target = {
  mode: "remote" as const,
  databaseId: "00000000-0000-0000-0000-000000000000",
  accountId: "a".repeat(32),
};
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch: number, id: string, c: RestoreD1Challenge;
const observation = () => ({
  bookmark: "opaque",
  timestamp: new Date(c.issuedAt - 60000).toISOString(),
});
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
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await control().attestDatabaseRestoreD1(epoch, id, c);
});
afterEach(() => vi.restoreAllMocks());
const attest = () => control().attestDatabaseRestoreBookmark(epoch, id, c, observation());
function rows(state: DurableObjectState) {
  return state.storage.sql
    .exec("SELECT * FROM control_database_restore_bookmark WHERE id=?", id)
    .toArray();
}
function verifiedAt(state: DurableObjectState) {
  return state.storage.sql
    .exec<{ verified_at: number }>(
      "SELECT verified_at FROM control_database_restore_target WHERE id=?",
      id,
    )
    .one().verified_at;
}
function service(state: DurableObjectState, effect: () => Promise<void> = async () => {}) {
  const db = {
    prepare: (query: string) => ({
      all: async () => {
        const result = await env.DB.prepare(query).all();
        await effect();
        return result;
      },
    }),
  } as unknown as D1Database;
  return new ControlRestoreTarget(
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
}
async function refuse(call: (instance: ControlDO) => Promise<unknown>, error: RegExp) {
  await runInDurableObject(control(), async (instance) => {
    await expect(call(instance)).rejects.toThrow(error);
  });
}

it("persists the selected bookmark and target outside D1 across eviction while keeping admission closed", async () => {
  await evictDurableObject(control());
  const saved = await attest();
  expect(saved).toMatchObject({
    id,
    epoch,
    target,
    ...observation(),
    state: "bookmark_verified",
    validator: "time-travel-bookmark-v1",
    challengeId: c.challengeId,
    revision: c.revision,
    expiresAt: c.expiresAt,
  });
  expect(saved).not.toHaveProperty("token");
  await evictDurableObject(control());
  await runInDurableObject(control(), async (_instance, state) => {
    expect(rows(state)).toEqual([
      expect.objectContaining({
        bookmark: "opaque",
        requested_timestamp: observation().timestamp,
        target_json: JSON.stringify(target),
        challenge_id: c.challengeId,
        token: c.token,
        verified_at: saved.verifiedAt,
      }),
    ]);
  });
  expect((await attest()).verifiedAt).toBeGreaterThanOrEqual(saved.verifiedAt);
  expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
  await refuse((instance) => instance.resumeAdmission(epoch), /database_restore_active/);
});

it("requires D1 attestation for the exact challenge and invalidates prior bookmark evidence on renewal", async () => {
  const previous = c;
  await attest();
  c = await control().challengeDatabaseRestoreD1(epoch, id, target);
  await refuse(
    (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, previous, observation()),
    /target_conflict/,
  );
  await refuse(
    (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, c, observation()),
    /target_unverified/,
  );
  await control().attestDatabaseRestoreD1(epoch, id, c);
  expect(await attest()).toMatchObject({ challengeId: c.challengeId });
});

it.each(["bookmark", "timestamp", "future", "target", "challenge", "epoch"])(
  "rejects altered %s",
  async (kind) => {
    const input = observation(),
      challenge = structuredClone(c);
    if (kind === "bookmark") input.bookmark = "different";
    if (kind === "timestamp") input.timestamp = "2026-02-30T00:00:00.000Z";
    if (kind === "future") input.timestamp = new Date(c.issuedAt + 1).toISOString();
    if (kind === "target") challenge.target.databaseId = crypto.randomUUID();
    if (kind === "challenge") challenge.challengeId = crypto.randomUUID();
    if (kind === "epoch") challenge.epoch++;
    await refuse(
      (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, challenge, input),
      /database_restore_/,
    );
    await runInDurableObject(control(), async (_instance, state) => {
      expect(rows(state)).toEqual([]);
    });
  },
);

it.each(["local", "logical"])(
  "does not certify %s requests as Time Travel observations",
  async (kind) => {
    await control().cancelDatabaseRestore(epoch, id);
    id = crypto.randomUUID();
    await control().prepareDatabaseRestore(
      epoch,
      id,
      kind === "logical"
        ? { kind: "logical", id: crypto.randomUUID(), epoch: 1, manifestSha256: "b".repeat(64) }
        : { kind: "time_travel", bookmark: "opaque" },
    );
    c = await control().challengeDatabaseRestoreD1(
      epoch,
      id,
      kind === "local" ? { mode: "local", databaseId: target.databaseId } : target,
    );
    await control().attestDatabaseRestoreD1(epoch, id, c);
    await refuse(
      (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, c, observation()),
      /bookmark_unavailable/,
    );
  },
);

it.each(["cancel", "revision", "challenge", "expired", "backward"])(
  "rejects %s occurring during D1 readback",
  async (kind) => {
    await runInDurableObject(control(), async (_instance, state) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(verifiedAt(state) + 10);
      const effect = vi.fn(async () => {
        if (kind === "cancel") new ControlDatabaseRestore(state.storage.sql).cancel(epoch, id);
        if (kind === "revision")
          state.storage.sql.exec("UPDATE control_admission SET revision=revision+1");
        if (kind === "challenge")
          state.storage.sql.exec(
            "UPDATE control_database_restore_target SET challenge_id=?",
            crypto.randomUUID(),
          );
        if (kind === "expired") clock.mockReturnValue(c.expiresAt);
        if (kind === "backward") clock.mockReturnValue(c.issuedAt - 1);
      });
      const s = service(state, effect);
      await expect(s.attestBookmark(epoch, id, c, observation())).rejects.toThrow(
        /database_restore_/,
      );
      expect(effect).toHaveBeenCalledOnce();
      expect(rows(state)).toEqual([]);
    });
  },
);

it("does not save a bookmark when the D1 mirror was rolled back", async () => {
  await env.DB.prepare("UPDATE control SET admission_token=? WHERE singleton=1")
    .bind(crypto.randomUUID())
    .run();
  await refuse(
    (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, c, observation()),
    /target_mismatch/,
  );
});

it.each(["expired", "backward"])("rejects a %s clock before dispatch", async (kind) => {
  await runInDurableObject(control(), async (_instance, state) => {
    vi.spyOn(Date, "now").mockReturnValue(kind === "expired" ? c.expiresAt : c.issuedAt - 1);
    const read = vi.fn(async () => {});
    await expect(service(state, read).attestBookmark(epoch, id, c, observation())).rejects.toThrow(
      /target_expired/,
    );
    expect(read).not.toHaveBeenCalled();
  });
});

it("retains a newer bookmark observation when the clock steps backward within the same challenge", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const before = verifiedAt(state),
      clock = vi.spyOn(Date, "now").mockReturnValue(before + 100),
      s = service(state);
    const saved = await s.attestBookmark(epoch, id, c, observation());
    clock.mockReturnValue(before + 50);
    await expect(s.attestBookmark(epoch, id, c, observation())).rejects.toThrow(
      /bookmark_conflict/,
    );
    expect(rows(state)[0]?.verified_at).toBe(saved.verifiedAt);
  });
});

it.each(["ABORT", "IGNORE"])(
  "does not report success on storage %s and permits a fresh retry",
  async (failure) => {
    const saved = await attest();
    await runInDurableObject(control(), async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_bookmark BEFORE UPDATE ON control_database_restore_bookmark BEGIN SELECT RAISE(${failure}${failure === "ABORT" ? ",'disk_test'" : ""}); END`,
      );
      await expect(service(state).attestBookmark(epoch, id, c, observation())).rejects.toThrow(
        /disk_test|bookmark_conflict/,
      );
      expect(rows(state)[0]?.verified_at).toBe(saved.verifiedAt);
      state.storage.sql.exec("DROP TRIGGER fail_bookmark");
    });
    expect((await attest()).verifiedAt).toBeGreaterThanOrEqual(saved.verifiedAt);
  },
);

it("keeps bookmark reads exclusive with new challenges and D1 attestations", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const s = service(state, async () => {
      entered();
      await gate;
    });
    const pending = s.attestBookmark(epoch, id, c, observation());
    await started;
    await expect(s.attest(epoch, id, c)).rejects.toThrow(/target_busy/);
    await expect(s.challenge(epoch, id, target)).rejects.toThrow(/target_busy/);
    await expect(s.attestBookmark(epoch, id, c, observation())).rejects.toThrow(/target_busy/);
    release();
    expect(await pending).toMatchObject({ state: "bookmark_verified" });
  });
});

it("times out without late persistence and retries with a fresh read", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const s = service(state, async () => {
      entered();
      await gate;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rejected = expect(s.attestBookmark(epoch, id, c, observation())).rejects.toThrow(
        /target_timeout/,
      );
      await started;
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
    } finally {
      release();
      vi.useRealTimers();
    }
    expect(rows(state)).toEqual([]);
    expect(await service(state).attestBookmark(epoch, id, c, observation())).toMatchObject({
      state: "bookmark_verified",
    });
  });
});

it("rejects cancellation, stale epochs and a noncanonical ControlDO", async () => {
  await refuse(
    (instance) => instance.attestDatabaseRestoreBookmark(epoch + 1, id, c, observation()),
    /epoch_conflict/,
  );
  const other = env.CONTROL.get(env.CONTROL.idFromName("wrong"));
  await runInDurableObject(other, async (instance) => {
    await expect(
      instance.attestDatabaseRestoreBookmark(epoch, id, c, observation()),
    ).rejects.toThrow(/control_singleton_required/);
  });
  await control().cancelDatabaseRestore(epoch, id);
  await refuse(
    (instance) => instance.attestDatabaseRestoreBookmark(epoch, id, c, observation()),
    /not_preparing/,
  );
});
