import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  barrier,
  barrierQuery,
  importData,
  initialize,
  migrations,
  schemaDigest,
  schemaQuery,
  specs,
  tableDigests,
} from "./snapshot.mjs";

function identity(id, epoch) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error("invalid_backup_identity");
}
const versionList = (versions) => versions.map(({ name, sha256 }) => ({ name, sha256 }));
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("backup_destination_exists");
}
async function importFile(db, path, tableSpecs) {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("backup_not_regular_file");
    async function* chunks() {
      for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    }
    await importData(db, chunks(), tableSpecs);
    const after = await handle.stat();
    if (bytes !== before.size || bytes !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("backup_file_changed");
    return { file: "data.sql", bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
function frozenTarget(db, expected) {
  assert.deepEqual(
    barrier(db.prepare(barrierQuery).all(), expected.id, expected.epoch),
    expected,
    "backup_barrier_mismatch",
  );
  assert.throws(() => db.exec("UPDATE control SET updated_at=updated_at+1"), /backup_frozen/);
}

/** Capture only an already-frozen ControlDO generation. Never release or alter the source. */
export async function captureGeneration({
  directory,
  id,
  epoch,
  source,
  now = Date.now,
  progress = () => {},
}) {
  identity(id, epoch);
  const root = resolve(directory),
    target = join(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await open(join(root, `${id}.lock`), "wx", 0o600);
  let temporary, db;
  try {
    await absent(target);
    temporary = await mkdtemp(join(root, `.${id}-`));
    const versions = await migrations();
    db = initialize(join(temporary, "verification.sqlite"), versions);
    const tableSpecs = specs(db),
      expectedSchema = schemaDigest(db.prepare(schemaQuery).all());
    const generation = barrier(await source.query(barrierQuery), id, epoch);
    assert.deepEqual(
      (await source.query("SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name),
      versions.map((v) => v.name),
      "backup_migration_mismatch",
    );
    assert.equal(
      schemaDigest(await source.query(schemaQuery)),
      expectedSchema,
      "backup_source_schema_mismatch",
    );
    progress("source_fingerprints");
    const tables = await tableDigests(tableSpecs, source.query);
    assert.deepEqual(
      barrier(await source.query(barrierQuery), id, epoch),
      generation,
      "backup_barrier_changed",
    );
    progress("wrangler_export");
    await source.export(
      join(temporary, "data.sql"),
      tableSpecs.map((s) => s.name),
    );
    assert.deepEqual(
      barrier(await source.query(barrierQuery), id, epoch),
      generation,
      "backup_barrier_changed",
    );
    await chmod(join(temporary, "data.sql"), 0o600);
    progress("isolated_restore");
    const data = await importFile(db, join(temporary, "data.sql"), tableSpecs);
    frozenTarget(db, generation);
    assert.deepEqual(
      await tableDigests(tableSpecs, async (sql) => db.prepare(sql).all()),
      tables,
      "backup_source_data_mismatch",
    );
    const capturedAt = now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < generation.createdAt)
      throw new Error("backup_invalid_capture_time");
    const manifest = {
      format: "nextcloud-flare.logical-backup",
      version: 1,
      capturedAt,
      generation,
      schema: { migrations: versionList(versions), sha256: expectedSchema },
      data,
      tables,
    };
    db.close();
    db = null;
    await rm(join(temporary, "verification.sqlite"));
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    // Publish the complete local generation with a directory rename; never replace an existing generation.
    await absent(target);
    await rename(temporary, target);
    temporary = null;
    progress("local_generation_verified");
    return { directory: target, manifest };
  } finally {
    db?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.close();
    await rm(join(root, `${id}.lock`));
  }
}

/** Build a NEW frozen offline database; this is not live restore, epoch publication or service resumption. */
export async function restoreGeneration({ directory, target }) {
  const info = await lstat(join(directory, "manifest.json"));
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("backup_invalid_manifest");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.format !== "nextcloud-flare.logical-backup" || manifest.version !== 1)
    throw new Error("backup_unknown_format");
  identity(manifest.generation?.id, manifest.generation?.epoch);
  if (
    !Number.isSafeInteger(manifest.capturedAt) ||
    manifest.capturedAt < manifest.generation.createdAt
  )
    throw new Error("backup_invalid_capture_time");
  const versions = await migrations();
  assert.deepEqual(manifest.schema?.migrations, versionList(versions), "backup_migration_mismatch");
  const dataInfo = await lstat(join(directory, "data.sql"));
  if (!dataInfo.isFile()) throw new Error("backup_not_regular_file");
  // Exclusive creation guarantees that existing local or live database files cannot be overwritten.
  const owned = await open(target, "wx", 0o600);
  await owned.close();
  let db,
    success = false;
  try {
    db = initialize(target, versions);
    assert.equal(
      schemaDigest(db.prepare(schemaQuery).all()),
      manifest.schema.sha256,
      "backup_schema_mismatch",
    );
    const tableSpecs = specs(db);
    const data = await importFile(db, join(directory, "data.sql"), tableSpecs);
    assert.deepEqual(data, manifest.data, "backup_checksum_mismatch");
    frozenTarget(db, manifest.generation);
    assert.deepEqual(
      await tableDigests(tableSpecs, async (sql) => db.prepare(sql).all()),
      manifest.tables,
      "backup_data_mismatch",
    );
    success = true;
    return { target, manifest };
  } finally {
    db?.close();
    if (!success) await rm(target, { force: true });
  }
}
export async function verifyGeneration(directory) {
  const temporary = await mkdtemp(join(tmpdir(), "ncf-backup-verify-"));
  try {
    const { manifest } = await restoreGeneration({
      directory,
      target: join(temporary, "snapshot.sqlite"),
    });
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
