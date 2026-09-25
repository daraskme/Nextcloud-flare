import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  type BackupGeneration,
  type BackupPublication,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { sha256 } from "../../src/backup/publication";
import {
  type RestoreSourceAuthority,
  verifyRestoreSourcePage,
} from "../../src/backup/restoreSource";
import { publicationFixture } from "../fixtures/backupPublication";

let current: RestoreSourceAuthority;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  current = { epoch: 2, revision: 7, token: crypto.randomUUID() };
  await env.DB.prepare(`UPDATE control SET epoch=?,maintenance=1,gc_paused=1,
    admission_revision=?,admission_token=?`)
    .bind(current.epoch, current.revision, current.token)
    .run();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture({
  createdAt = Date.now() - 1000,
  chunks = [new TextEncoder().encode("transport fixture; not a verified SQL snapshot")],
  edit = (_publication: BackupPublication) => {},
}: {
  createdAt?: number;
  chunks?: Uint8Array[];
  edit?: (p: BackupPublication) => void;
} = {}) {
  const generation: BackupGeneration = {
    id: crypto.randomUUID(),
    epoch: 1,
    createdAt,
    token: crypto.randomUUID(),
    watermark: null,
  };
  const p = await publicationFixture(generation, chunks);
  edit(p);
  const bytes = new TextEncoder().encode(JSON.stringify(p)),
    hash = await sha256(bytes);
  await env.BACKUPS.put(backupManifestKey(generation.id), bytes);
  for (let i = 0; i < chunks.length; i++)
    await env.BACKUPS.put(backupPartKey(generation.id, i, p.parts[i]!.sha256), chunks[i]!);
  await env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark,
    completed_at,released_at,manifest_key,manifest_sha256) VALUES(?,?,'completed',?,?,?,?,?,?,?)`)
    .bind(
      generation.id,
      generation.epoch,
      createdAt,
      generation.token,
      generation.watermark,
      createdAt,
      createdAt,
      backupManifestKey(generation.id),
      hash,
    )
    .run();
  const source = {
    kind: "logical" as const,
    id: generation.id,
    epoch: generation.epoch,
    manifestSha256: hash,
  };
  const run = (cursor = 0, bucket = env.BACKUPS, selected = source) =>
    verifyRestoreSourcePage({
      db: env.DB,
      bucket,
      source: selected,
      cursor,
      authority: () => ({ ...current }),
    });
  return { generation, p, source, chunks, bytes, run };
}
function afterRead(effect: (key: string) => Promise<void>, keys: string[] = []): R2Bucket {
  return {
    async get(key: string) {
      keys.push(key);
      const value = await env.BACKUPS.get(key);
      await effect(key);
      return value;
    },
  } as unknown as R2Bucket;
}

it("checks a completed generation against its R2 bytes without changing D1 or objects", async () => {
  const f = await fixture();
  const before = await env.DB.prepare("SELECT * FROM backup_runs WHERE id=?")
    .bind(f.source.id)
    .first();
  const result = await f.run();
  expect(result).toEqual({
    generation: f.generation,
    manifestSha256: f.source.manifestSha256,
    parts: 1,
    next: 1,
    observedAt: expect.any(Number),
    expiresAt: f.generation.createdAt + BACKUP_MAX_AGE_MS,
  });
  expect(
    await env.DB.prepare("SELECT * FROM backup_runs WHERE id=?").bind(f.source.id).first(),
  ).toEqual(before);
  expect(await (await env.BACKUPS.get(backupManifestKey(f.source.id)))!.arrayBuffer()).toEqual(
    f.bytes.buffer,
  );
});

it("reads only one part per page and can refresh the completed cursor without rereading SQL parts", async () => {
  const f = await fixture({
    chunks: [new Uint8Array(8 * 1024 * 1024).fill(7), new Uint8Array([8])],
  });
  const keys: string[] = [],
    bucket = afterRead(async () => {}, keys);
  expect(await f.run(0, bucket)).toMatchObject({ parts: 2, next: 1 });
  expect(keys).toEqual([
    backupManifestKey(f.source.id),
    backupPartKey(f.source.id, 0, f.p.parts[0]!.sha256),
  ]);
  keys.length = 0;
  expect(await f.run(1, bucket)).toMatchObject({ parts: 2, next: 2 });
  expect(keys).toEqual([
    backupManifestKey(f.source.id),
    backupPartKey(f.source.id, 1, f.p.parts[1]!.sha256),
  ]);
  keys.length = 0;
  expect(await f.run(2, bucket)).toMatchObject({ parts: 2, next: 2 });
  expect(keys).toEqual([backupManifestKey(f.source.id)]);
  await expect(f.run(3)).rejects.toThrow(/restore_invalid_source_cursor/);
});

it.each(["hash", "epoch", "missing"] as const)(
  "rejects a %s selection before accessing R2",
  async (field) => {
    const f = await fixture(),
      keys: string[] = [];
    const source = {
      ...f.source,
      ...(field === "hash"
        ? { manifestSha256: "f".repeat(64) }
        : field === "epoch"
          ? { epoch: 2 }
          : { id: crypto.randomUUID() }),
    };
    await expect(
      f.run(
        0,
        afterRead(async () => {}, keys),
        source,
      ),
    ).rejects.toThrow(/restore_source_receipt_invalid/);
    expect(keys).toEqual([]);
  },
);

it.each(["open", "revision", "token", "epoch", "gc"] as const)(
  "rejects a %s D1 mirror",
  async (field) => {
    const f = await fixture();
    const sql = {
      open: "UPDATE control SET maintenance=0",
      revision: "UPDATE control SET admission_revision=8",
      token: "UPDATE control SET admission_token='different-token'",
      epoch: "UPDATE control SET epoch=3",
      gc: "UPDATE control SET gc_paused=0",
    }[field];
    await env.DB.prepare(sql).run();
    const keys: string[] = [];
    await expect(
      f.run(
        0,
        afterRead(async () => {}, keys),
      ),
    ).rejects.toThrow(/restore_source_mirror_conflict/);
    expect(keys).toEqual([]);
  },
);

it.each(["pending", "exporting", "failed"] as const)(
  "rejects an uncompleted %s receipt",
  async (state) => {
    const f = await fixture();
    await env.DB.prepare("DELETE FROM backup_runs WHERE id=?").bind(f.source.id).run();
    await env.DB.prepare(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,?,?,?)",
    )
      .bind(f.source.id, state, f.generation.createdAt, f.generation.token)
      .run();
    await expect(f.run()).rejects.toThrow(/restore_source_receipt_invalid/);
  },
);

it.each(["missing", "changed"] as const)("rejects a %s R2 manifest", async (mode) => {
  const f = await fixture(),
    key = backupManifestKey(f.source.id);
  if (mode === "missing") await env.BACKUPS.delete(key);
  else await env.BACKUPS.put(key, new Uint8Array([1]));
  await expect(f.run()).rejects.toThrow(/restore_source_manifest_mismatch/);
});

it.each(["missing", "changed"] as const)(
  "rejects a %s SQL part despite an intact manifest",
  async (mode) => {
    const f = await fixture(),
      key = backupPartKey(f.source.id, 0, f.p.parts[0]!.sha256);
    if (mode === "missing") await env.BACKUPS.delete(key);
    else await env.BACKUPS.put(key, new Uint8Array(f.chunks[0]!.byteLength).fill(7));
    await expect(f.run()).rejects.toThrow(/restore_source_part_mismatch/);
  },
);

it("rejects a manifest that does not identify the exact completed barrier", async () => {
  const f = await fixture({
    edit: (p) => {
      p.manifest.generation = { ...p.manifest.generation, token: crypto.randomUUID() };
    },
  });
  await expect(f.run()).rejects.toThrow(/restore_source_generation_mismatch/);
});

it("rechecks the local restore identity after each read before dispatching the next one", async () => {
  const f = await fixture(),
    keys: string[] = [];
  await expect(
    f.run(
      0,
      afterRead(async () => {
        current.token = crypto.randomUUID();
      }, keys),
    ),
  ).rejects.toThrow(/restore_source_changed/);
  expect(keys).toEqual([backupManifestKey(f.source.id)]);
});

it.each(["mirror", "receipt"] as const)(
  "does not accept a page after the %s changes during the SQL read",
  async (field) => {
    const f = await fixture();
    const bucket = afterRead(async (key) => {
      if (key === backupManifestKey(f.source.id)) return;
      if (field === "mirror")
        await env.DB.prepare("UPDATE control SET admission_token='changed'").run();
      else await env.DB.prepare("DELETE FROM backup_runs WHERE id=?").bind(f.source.id).run();
    });
    await expect(f.run(0, bucket)).rejects.toThrow(
      field === "mirror" ? /restore_source_mirror_conflict/ : /restore_source_receipt_invalid/,
    );
  },
);

it("accepts exactly 35 days and refuses the next millisecond", async () => {
  const now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const f = await fixture({ createdAt: now - BACKUP_MAX_AGE_MS });
  expect(await f.run()).toMatchObject({ expiresAt: now });
  clock.mockReturnValue(now + 1);
  await expect(f.run()).rejects.toThrow(/restore_source_expired/);
});

it("refuses a generation that expires during verification", async () => {
  const now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const f = await fixture({ createdAt: now - BACKUP_MAX_AGE_MS });
  await expect(
    f.run(
      0,
      afterRead(async (key) => {
        if (key !== backupManifestKey(f.source.id)) clock.mockReturnValue(now + 1);
      }),
    ),
  ).rejects.toThrow(/restore_source_expired/);
});

it("rejects future completion timestamps", async () => {
  const f = await fixture({ createdAt: Date.now() + 60000 });
  await expect(f.run()).rejects.toThrow(/restore_source_receipt_invalid/);
});

it.each([-1, 25000])(
  "does not dispatch the next read after a clock change of %i milliseconds",
  async (shift) => {
    const now = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const f = await fixture(),
      keys: string[] = [];
    await expect(
      f.run(
        0,
        afterRead(async () => {
          clock.mockReturnValue(now + shift);
        }, keys),
      ),
    ).rejects.toThrow(/restore_source_deadline/);
    expect(keys).toEqual([backupManifestKey(f.source.id)]);
  },
);

it("cancels a late R2 body after timeout without reading another part", async () => {
  const f = await fixture();
  let resolve!: (value: R2ObjectBody) => void;
  const get = vi.fn(
    () =>
      new Promise<R2ObjectBody>((done) => {
        resolve = done;
      }),
  );
  await expect(f.run(0, { get } as unknown as R2Bucket)).rejects.toThrow(/timeout/);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  resolve({ size: f.bytes.byteLength, body } as R2ObjectBody);
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
});

it("does not start an R2 read after a timed out primary observation eventually arrives", async () => {
  const f = await fixture();
  let resolve!: (value: D1Result[]) => void, statements!: D1PreparedStatement[];
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (input: D1PreparedStatement[]) => {
      statements = input;
      return new Promise<D1Result[]>((done) => {
        resolve = done;
      });
    },
  } as D1Database;
  const get = vi.fn();
  await expect(
    verifyRestoreSourcePage({
      db,
      bucket: { get } as unknown as R2Bucket,
      source: f.source,
      cursor: 0,
      authority: () => current,
    }),
  ).rejects.toThrow(/restore_source_timeout/);
  resolve(await env.DB.batch(statements));
  await Promise.resolve();
  await Promise.resolve();
  expect(get).not.toHaveBeenCalled();
});
