import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreFreezeTargets } from "../../packages/shared/src/restoreFreeze.ts";
import {
  restoreSnapshotChallenge,
  restoreSnapshotProof,
} from "../../packages/shared/src/restoreSnapshot.ts";
import {
  RESTORE_SNAPSHOT_CATALOGUE_QUERY,
  RESTORE_SNAPSHOT_CONTROL_QUERY,
  RESTORE_SNAPSHOT_MIGRATIONS_QUERY,
  RESTORE_SNAPSHOT_SCHEMA_QUERY,
  restoredSnapshotMirror,
} from "../../packages/worker/src/db/restoreSnapshot.ts";
import { exportData } from "../backup/export.mjs";
import {
  importData,
  initialize,
  migrations,
  schemaCatalogue,
  schemaDigest,
  schemaQuery,
  specs,
  tableDigests,
} from "../backup/snapshot.mjs";
import { restoreStatus } from "./verify.mjs";

const same = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("database_restore_snapshot_changed");
};

/** Compare the whole restored source with an isolated, trusted-schema import. Never writes D1. */
export async function verifyRestoredSnapshot({ epoch, id, control, reader, progress = () => {} }) {
  const targets = restoreFreezeTargets({
    target: reader.target,
    blobs: reader.blobsTarget,
    backups: reader.backupsTarget,
  });
  await reader.assertUnchanged();
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (
    !["restore_written", "snapshot_checking", "snapshot_verified"].includes(selected.state) ||
    typeof reader.snapshotQuery !== "function"
  )
    throw new Error("database_restore_snapshot_unavailable");
  const challenge = restoreSnapshotChallenge(await control.challengeSnapshot(epoch, id, targets));
  if (challenge.id !== id || challenge.epoch !== epoch || challenge.newEpoch !== selected.newEpoch)
    throw new Error("database_restore_invalid_snapshot_challenge");
  same(challenge.targets, targets);
  same(challenge.restoreResult, selected.restoreResult);
  const current = async () => {
    const clock = () => {
      if (Date.now() < challenge.issuedAt || Date.now() >= challenge.expiresAt)
        throw new Error("database_restore_snapshot_expired");
    };
    clock();
    await reader.assertUnchanged();
    clock();
  };
  const query = async (sql) => {
    await current();
    const result = await reader.snapshotQuery(sql);
    await current();
    return result;
  };
  const available = await migrations(),
    recorded = await query(RESTORE_SNAPSHOT_MIGRATIONS_QUERY),
    minimum = available.findIndex((m) => m.name === "0037_backup_barrier.sql") + 1;
  if (
    !Array.isArray(recorded) ||
    minimum < 1 ||
    recorded.length < minimum ||
    recorded.length > available.length
  )
    throw new Error("database_restore_snapshot_migration_mismatch");
  const versions = available.slice(0, recorded.length);
  same(
    recorded.map((m) => m.name),
    versions.map((m) => m.name),
  );
  const directory = await mkdtemp(join(tmpdir(), "ncf-restored-snapshot-"));
  let db;
  try {
    db = initialize(join(directory, "verification.sqlite"), versions);
    const tableSpecs = specs(db, { historical: true }),
      expectedSchema = schemaDigest(db.prepare(schemaQuery).all()),
      expectedCatalogue = schemaCatalogue(db.prepare("PRAGMA table_list").all());
    const checkSource = async () => {
      same(
        (await query(RESTORE_SNAPSHOT_MIGRATIONS_QUERY)).map((m) => m.name),
        versions.map((m) => m.name),
      );
      const controlRows = await query(RESTORE_SNAPSHOT_CONTROL_QUERY),
        schema = await query(RESTORE_SNAPSHOT_SCHEMA_QUERY),
        catalogue = await query(RESTORE_SNAPSHOT_CATALOGUE_QUERY);
      same(schemaDigest(schema), expectedSchema);
      same(schemaCatalogue(catalogue), expectedCatalogue);
      same(await restoredSnapshotMirror(controlRows, schema, catalogue), challenge.mirror);
    };
    await checkSource();
    const before = await tableDigests(tableSpecs, query);
    progress({ stage: "restored_snapshot_read", tables: before.length });
    const path = join(directory, "data.sql");
    await exportData(path, tableSpecs, query);
    await checkSource();
    const hash = createHash("sha256");
    let bytes = 0;
    async function* chunks() {
      for await (const part of createReadStream(path)) {
        await current();
        hash.update(part);
        bytes += part.length;
        yield part;
      }
    }
    await importData(db, chunks(), tableSpecs);
    const tables = await tableDigests(tableSpecs, async (sql) => db.prepare(sql).all());
    same(tables, before);
    // A restored DB does not yet have the new admission barrier. Require a second
    // whole-source pass; this observation is still not a durable adoption permission.
    same(await tableDigests(tableSpecs, query), before);
    await checkSource();
    const proof = restoreSnapshotProof(
      {
        validator: "restored-snapshot-v1",
        schemaSha256: expectedSchema,
        migrations: versions.map((m) => ({ name: m.name, sha256: m.sha256 })),
        data: { bytes, sha256: hash.digest("hex") },
        tables,
      },
      challenge,
    );
    await current();
    const saved = await control.attestSnapshot(epoch, id, challenge, proof);
    await current();
    const status = restoreStatus(saved, epoch, id);
    if (
      status.state !== "snapshot_verified" ||
      status.newEpoch !== selected.newEpoch ||
      status.createdAt !== selected.createdAt ||
      status.snapshotVerifiedAt < challenge.issuedAt ||
      status.snapshotVerifiedAt >= challenge.expiresAt ||
      saved.validator !== proof.validator ||
      saved.schemaSha256 !== proof.schemaSha256 ||
      saved.dataSha256 !== proof.data.sha256 ||
      saved.tables !== tables.length ||
      saved.bytes !== bytes
    )
      throw new Error("database_restore_invalid_snapshot_proof");
    same(status.source, selected.source);
    same(status.restoreResult, selected.restoreResult);
    return {
      ...status,
      validator: proof.validator,
      schemaSha256: proof.schemaSha256,
      dataSha256: proof.data.sha256,
      tables: tables.length,
      bytes,
    };
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
