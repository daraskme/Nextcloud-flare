import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { backupManifestKey, backupPartKey } from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { sha256 } from "../../src/backup/publication";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlRestoreSource } from "../../src/do/controlRestoreSource";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { publicationFixture } from "../fixtures/backupPublication";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch: number;
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
});
afterEach(() => {
  vi.restoreAllMocks();
});

function verifier(state: DurableObjectState, bucket = env.BACKUPS) {
  return new ControlRestoreSource(
    state.storage.sql,
    env.DB,
    bucket,
    new ControlDatabaseRestore(state.storage.sql),
    (expected) => {
      const row = state.storage.sql
        .exec<{ epoch: number; revision: number; token: string }>(
          `SELECT a.epoch,a.revision,a.token
        FROM control_admission a JOIN control_state c ON c.singleton=a.singleton AND c.epoch=a.epoch
        WHERE c.phase='ready' AND a.phase='closed' AND a.epoch=?`,
          expected,
        )
        .toArray()[0];
      if (!row) throw new Error("recovery_admission_not_closed");
      return row;
    },
  );
}
function progress(state: DurableObjectState, id: string) {
  return state.storage.sql
    .exec<{ cursor: number; total: number; observed_at: number | null }>(
      "SELECT cursor,total,observed_at FROM control_database_restore_source WHERE id=?",
      id,
    )
    .one();
}
async function fixture(multiple = false) {
  const id = crypto.randomUUID(),
    generation = {
      id: crypto.randomUUID(),
      epoch: 1,
      createdAt: Date.now() - 1000,
      token: crypto.randomUUID(),
      watermark: null,
    };
  const chunks = multiple
    ? [new Uint8Array(8 * 1024 * 1024), new Uint8Array([7])]
    : [new Uint8Array([7])];
  const publication = await publicationFixture(generation, chunks);
  const bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  await env.BACKUPS.put(backupManifestKey(generation.id), bytes);
  const keys = publication.parts.map((part, i) => backupPartKey(generation.id, i, part.sha256));
  for (let i = 0; i < chunks.length; i++) await env.BACKUPS.put(keys[i]!, chunks[i]!);
  await env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,
    completed_at,released_at,manifest_key,manifest_sha256) VALUES(?,1,'completed',?,?,?,?,?,?)`)
    .bind(
      generation.id,
      generation.createdAt,
      generation.token,
      generation.createdAt,
      generation.createdAt,
      backupManifestKey(generation.id),
      hash,
    )
    .run();
  await control().prepareDatabaseRestore(epoch, id, {
    kind: "logical",
    id: generation.id,
    epoch: 1,
    manifestSha256: hash,
  });
  return { id, generation, keys, chunks, hash };
}
function bucketAfterRead(effect: (key: string) => Promise<void>): R2Bucket {
  return {
    async get(key: string) {
      const object = await env.BACKUPS.get(key);
      await effect(key);
      return object;
    },
  } as unknown as R2Bucket;
}

it("persists one verified part per call and resumes after DO eviction", async () => {
  const f = await fixture(true);
  expect(await control().verifyDatabaseRestoreSource(epoch, f.id)).toMatchObject({
    id: f.id,
    epoch,
    state: "verifying",
    partsVerified: 1,
    partsTotal: 2,
    manifestSha256: f.hash,
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (_instance, state) => {
    const keys: string[] = [],
      service = verifier(
        state,
        bucketAfterRead(async (key) => {
          keys.push(key);
        }),
      );
    expect(await service.verify(epoch, f.id)).toMatchObject({
      state: "parts_verified",
      partsVerified: 2,
    });
    expect(keys).toEqual([backupManifestKey(f.generation.id), f.keys[1]]);
    keys.length = 0;
    expect(await service.verify(epoch, f.id)).toMatchObject({
      state: "parts_verified",
      partsVerified: 2,
    });
    expect(keys).toEqual([backupManifestKey(f.generation.id)]);
    expect(progress(state, f.id)).toMatchObject({ cursor: 2, total: 2 });
  });
  expect((await control().status()).maintenance).toBe(true);
  expect(await control().verifyDatabaseRestoreSource(epoch, f.id)).toMatchObject({
    state: "parts_verified",
    partsVerified: 2,
  });
});

it("retains the same cursor after a missing part and succeeds only after its exact bytes return", async () => {
  const f = await fixture(true);
  await runInDurableObject(control(), async (_instance, state) => {
    await verifier(state).verify(epoch, f.id);
  });
  await env.BACKUPS.delete(f.keys[1]!);
  await evictDurableObject(control());
  await runInDurableObject(control(), async (_instance, state) => {
    const service = verifier(state),
      before = progress(state, f.id);
    await expect(service.verify(epoch, f.id)).rejects.toThrow(/restore_source_part_mismatch/);
    expect(progress(state, f.id)).toEqual(before);
    await env.BACKUPS.put(f.keys[1]!, f.chunks[1]!);
    expect(await service.verify(epoch, f.id)).toMatchObject({ state: "parts_verified" });
  });
});

it("does not save progress after cancellation during a read", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (instance, state) => {
    const service = verifier(
      state,
      bucketAfterRead(async () => {
        await instance.cancelDatabaseRestore(epoch, f.id);
      }),
    );
    await expect(service.verify(epoch, f.id)).rejects.toThrow(/database_restore_not_preparing/);
    expect(progress(state, f.id)).toEqual({ cursor: 0, total: 0, observed_at: null });
    await expect(verifier(state).verify(epoch, f.id)).rejects.toThrow(
      /database_restore_not_preparing/,
    );
  });
});

it("does not skip a part when a late verifier loses its cursor compare-and-swap", async () => {
  const f = await fixture(true);
  await runInDurableObject(control(), async (_instance, state) => {
    let once = false;
    const delayed = verifier(
      state,
      bucketAfterRead(async () => {
        if (once) return;
        once = true;
        expect(await verifier(state).verify(epoch, f.id)).toMatchObject({ partsVerified: 1 });
      }),
    );
    await expect(delayed.verify(epoch, f.id)).rejects.toThrow(/database_restore_source_conflict/);
    expect(progress(state, f.id)).toMatchObject({ cursor: 1, total: 2 });
    expect(await verifier(state).verify(epoch, f.id)).toMatchObject({ partsVerified: 2 });
  });
});

it("admits only one verification read at a time on the same instance", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (_instance, state) => {
    const service = verifier(
      state,
      bucketAfterRead(async () => {
        await expect(service.verify(epoch, f.id)).rejects.toThrow(/database_restore_source_busy/);
      }),
    );
    expect(await service.verify(epoch, f.id)).toMatchObject({ state: "parts_verified" });
  });
});

it("refuses to save a page after repair changes the admission revision", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (instance, state) => {
    const service = verifier(
      state,
      bucketAfterRead(async () => {
        await instance.quiesce(epoch);
      }),
    );
    await expect(service.verify(epoch, f.id)).rejects.toThrow(/restore_source_changed/);
    expect(progress(state, f.id).cursor).toBe(0);
    expect(await verifier(state).verify(epoch, f.id)).toMatchObject({ state: "parts_verified" });
  });
});

it("does not reuse verified metadata after the generation expires", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (_instance, state) => {
    const service = verifier(state);
    await service.verify(epoch, f.id);
    const before = progress(state, f.id);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(f.generation.createdAt + BACKUP_MAX_AGE_MS + 1);
    try {
      await expect(service.verify(epoch, f.id)).rejects.toThrow(/restore_source_expired/);
    } finally {
      clock.mockRestore();
    }
    expect(progress(state, f.id)).toEqual(before);
  });
});

it("does not move a saved verification timestamp backwards after eviction", async () => {
  const f = await fixture(),
    now = Date.now();
  await runInDurableObject(control(), async (instance) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await instance.verifyDatabaseRestoreSource(epoch, f.id);
    } finally {
      clock.mockRestore();
    }
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance, state) => {
    const before = progress(state, f.id),
      clock = vi.spyOn(Date, "now").mockReturnValue(now - 1);
    try {
      await expect(instance.verifyDatabaseRestoreSource(epoch, f.id)).rejects.toThrow(
        /database_restore_source_clock_conflict/,
      );
    } finally {
      clock.mockRestore();
    }
    expect(progress(state, f.id)).toEqual(before);
  });
});

it("preserves a newer observation when a stale completed refresh races with clock rollback", async () => {
  const f = await fixture(),
    now = Date.now();
  await runInDurableObject(control(), async (_instance, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await verifier(state).verify(epoch, f.id);
      const delayed = verifier(
        state,
        bucketAfterRead(async () => {
          clock.mockReturnValue(now + 1);
          expect(await verifier(state).verify(epoch, f.id)).toMatchObject({
            state: "parts_verified",
            observedAt: now + 1,
          });
          clock.mockReturnValue(now);
        }),
      );
      await expect(delayed.verify(epoch, f.id)).rejects.toThrow(/database_restore_source_conflict/);
      expect(progress(state, f.id)).toEqual({ cursor: 1, total: 1, observed_at: now + 1 });
    } finally {
      clock.mockRestore();
    }
  });
});

it("keeps the cursor before a storage failure and can repeat the read", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (_instance, state) => {
    const service = verifier(state);
    state.storage.sql.exec(
      "CREATE TRIGGER fail_source_cursor BEFORE UPDATE ON control_database_restore_source BEGIN SELECT RAISE(ABORT,'source_storage_failed'); END",
    );
    try {
      await expect(service.verify(epoch, f.id)).rejects.toThrow(/source_storage_failed/);
    } finally {
      state.storage.sql.exec("DROP TRIGGER fail_source_cursor");
    }
    expect(progress(state, f.id).cursor).toBe(0);
    expect(await service.verify(epoch, f.id)).toMatchObject({ state: "parts_verified" });
  });
});

it("does not interpret a Time Travel selection as a logical publication", async () => {
  const id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, {
    kind: "time_travel",
    bookmark: "opaque-bookmark",
  });
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.verifyDatabaseRestoreSource(epoch, id)).rejects.toThrow(
      /database_restore_source_unavailable/,
    );
    expect(
      state.storage.sql.exec("SELECT 1 FROM control_database_restore_source").toArray(),
    ).toEqual([]);
  });
});

it("keeps the current epoch and singleton checks on the actual verification RPC", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.verifyDatabaseRestoreSource(epoch + 1, f.id)).rejects.toThrow(
      /database_restore_epoch_conflict/,
    );
    await expect(instance.verifyDatabaseRestoreSource(epoch, crypto.randomUUID())).rejects.toThrow(
      /database_restore_missing/,
    );
    await instance.cancelDatabaseRestore(epoch, f.id);
    await expect(instance.verifyDatabaseRestoreSource(epoch, f.id)).rejects.toThrow(
      /database_restore_not_preparing/,
    );
  });
  const other = env.CONTROL.get(env.CONTROL.idFromName("another-restore-control"));
  await runInDurableObject(other, async (instance) => {
    await expect(instance.verifyDatabaseRestoreSource(epoch, f.id)).rejects.toThrow(
      /control_singleton_required/,
    );
  });
});

it("does not verify a persisted request whose D1 stop has not completed", async () => {
  const f = await fixture(),
    id = crypto.randomUUID();
  await runInDurableObject(control(), async (instance, state) => {
    await instance.cancelDatabaseRestore(epoch, f.id);
    await instance.beginRecoveryAudit(epoch);
    let complete = false;
    for (let page = 0; page < 20; page++)
      if ((await instance.nextRecoveryAuditPage(epoch)).completed) {
        complete = true;
        break;
      }
    expect(complete).toBe(true);
    await instance.resumeAdmission(epoch);
    const unavailable = new ControlDO(state, {
      ...env,
      DB: {
        prepare() {
          throw new Error("primary_unavailable");
        },
      } as unknown as D1Database,
    });
    await expect(
      unavailable.prepareDatabaseRestore(epoch, id, {
        kind: "logical",
        id: f.generation.id,
        epoch: 1,
        manifestSha256: f.hash,
      }),
    ).rejects.toThrow(/primary_unavailable/);
    await expect(instance.verifyDatabaseRestoreSource(epoch, id)).rejects.toThrow(
      /recovery_admission_not_closed/,
    );
    expect(
      state.storage.sql
        .exec("SELECT 1 FROM control_database_restore_source WHERE id=?", id)
        .toArray(),
    ).toEqual([]);
  });
});

it("requires an existing same-epoch preparing request before reading R2", async () => {
  const f = await fixture();
  await runInDurableObject(control(), async (_instance, state) => {
    const get = vi.fn(),
      service = verifier(state, { get } as unknown as R2Bucket);
    await expect(service.verify(epoch, crypto.randomUUID())).rejects.toThrow(
      /database_restore_missing/,
    );
    await expect(service.verify(epoch + 1, f.id)).rejects.toThrow(/database_restore_conflict/);
    expect(get).not.toHaveBeenCalled();
  });
});
