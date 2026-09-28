import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_SNAPSHOT_WINDOW_MS } from "../../packages/shared/src/restoreSnapshot.ts";
import {
  RESTORE_SNAPSHOT_CATALOGUE_QUERY,
  RESTORE_SNAPSHOT_CONTROL_QUERY,
  RESTORE_SNAPSHOT_MIGRATIONS_QUERY,
  RESTORE_SNAPSHOT_SCHEMA_QUERY,
  restoredSnapshotMirror,
} from "../../packages/worker/src/db/restoreSnapshot.ts";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";
import { initialize, migrations, specs, tableDigests } from "../backup/snapshot.mjs";
import { verifyRestoredSnapshot } from "../restore/snapshot.mjs";

let db, versions, selected, reader, control, c, fixture;
const rows = async (sql) =>
  sql === RESTORE_SNAPSHOT_MIGRATIONS_QUERY
    ? versions.map((m) => ({ name: m.name }))
    : db.prepare(sql).all();
beforeEach(async () => {
  versions = await migrations();
  db = initialize(":memory:", versions);
  fixture = foundationFixture("restored-snapshot", Date.now() - 1000);
  for (const statement of fixture.statements)
    db.prepare(statement.sql).run(...(statement.values ?? []));
  db.prepare("UPDATE users SET email=?").run("\ufeff引用'😀;\r\n文字\\n\0end");
  for (const state of ["committed", "failed"]) {
    db.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,1,'released')",
    ).run(state, fixture.ids.space);
    db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
      permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user',?,?,?,'node.create',?,'digest',1,?,1,1,0,1,1)`).run(
      state,
      fixture.ids.user,
      fixture.ids.credential,
      fixture.ids.space,
      state,
      state,
    );
  }
  db.prepare(
    "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'sample','sample','fixture',1)",
  ).run(fixture.ids.file, fixture.ids.space);
  const accountId = "a".repeat(32),
    now = Date.now();
  selected = {
    id: randomUUID(),
    epoch: 2,
    newEpoch: 3,
    state: "restore_written",
    createdAt: now - 60000,
    source: { kind: "time_travel", bookmark: "selected" },
    restoreResult: { bookmark: "restored", previousBookmark: "before" },
  };
  reader = {
    target: { mode: "remote", accountId, databaseId: randomUUID() },
    blobsTarget: { accountId, bucket: "blobs", jurisdiction: "default" },
    backupsTarget: { accountId, bucket: "backups", jurisdiction: "default" },
    assertUnchanged: vi.fn(async () => {}),
    snapshotQuery: vi.fn(rows),
  };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    challengeSnapshot: vi.fn(async () => {
      const issuedAt = Date.now();
      c = {
        id: selected.id,
        epoch: 2,
        newEpoch: 3,
        targets: {
          target: reader.target,
          blobs: reader.blobsTarget,
          backups: reader.backupsTarget,
        },
        restoreResult: selected.restoreResult,
        challengeId: randomUUID(),
        issuedAt,
        expiresAt: issuedAt + RESTORE_SNAPSHOT_WINDOW_MS,
        mirror: await restoredSnapshotMirror(
          await rows(RESTORE_SNAPSHOT_CONTROL_QUERY),
          await rows(RESTORE_SNAPSHOT_SCHEMA_QUERY),
          await rows(RESTORE_SNAPSHOT_CATALOGUE_QUERY),
        ),
      };
      return c;
    }),
    attestSnapshot: vi.fn(async (_epoch, _id, _challenge, proof) => ({
      ...selected,
      state: "snapshot_verified",
      snapshotVerifiedAt: Date.now(),
      validator: proof.validator,
      schemaSha256: proof.schemaSha256,
      dataSha256: proof.data.sha256,
      tables: proof.tables.length,
      bytes: proof.data.bytes,
      token: "do-not-print",
    })),
    cancel: vi.fn(),
  };
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const run = () => verifyRestoredSnapshot({ epoch: 2, id: selected.id, control, reader });

it("checks all tables, FK and isolated FTS while preserving exact values and operation terminals", async () => {
  const before = await tableDigests(specs(db), rows),
    saved = await run();
  expect(saved).toMatchObject({ state: "snapshot_verified", epoch: 2, newEpoch: 3, tables: 74 });
  expect(JSON.stringify(saved)).not.toContain("do-not-print");
  expect(await tableDigests(specs(db), rows)).toEqual(before);
  expect(control.attestSnapshot.mock.calls[0][3].tables).toEqual(before);
  expect(
    db
      .prepare("SELECT state FROM operations ORDER BY state")
      .all()
      .map((r) => r.state),
  ).toEqual(["committed", "failed"]);
  expect(control.cancel).not.toHaveBeenCalled();
});
it("accepts an older exact trusted migration prefix without upgrading the source", async () => {
  db.close();
  versions = versions.slice(0, versions.findIndex((m) => m.name === "0037_backup_barrier.sql") + 1);
  db = initialize(":memory:", versions);
  expect((await run()).tables).toBe(67);
  expect(
    db
      .prepare("PRAGMA table_info(control)")
      .all()
      .some((r) => r.name === "restore_freeze_token"),
  ).toBe(false);
});
it.each(["extra_table", "missing_trigger", "migration_order", "migration_missing"])(
  "rejects an untrusted source schema: %s",
  async (kind) => {
    if (kind === "extra_table") db.exec("CREATE TABLE extra_data(id TEXT PRIMARY KEY) STRICT");
    if (kind === "missing_trigger") db.exec('DROP TRIGGER "restore_freeze_users_insert"');
    if (kind === "migration_order")
      reader.snapshotQuery.mockImplementation(async (sql) =>
        sql === RESTORE_SNAPSHOT_MIGRATIONS_QUERY ? [...(await rows(sql))].reverse() : rows(sql),
      );
    if (kind === "migration_missing")
      reader.snapshotQuery.mockImplementation(async (sql) =>
        sql === RESTORE_SNAPSHOT_MIGRATIONS_QUERY ? [] : rows(sql),
      );
    await expect(run()).rejects.toThrow();
    expect(control.attestSnapshot).not.toHaveBeenCalled();
  },
);
it("rejects a foreign-key violation even when every source pass agrees", async () => {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("INSERT INTO node_props VALUES('missing','fixture','property','value')");
  await expect(run()).rejects.toThrow(/foreign_key/);
  expect(control.attestSnapshot).not.toHaveBeenCalled();
});
it("rejects data changing between its first fingerprint and isolated import", async () => {
  let changed = false;
  reader.snapshotQuery.mockImplementation(async (sql) => {
    const result = await rows(sql);
    if (!changed && sql.includes('FROM "users"')) {
      changed = true;
      db.prepare("UPDATE users SET email='changed'").run();
    }
    return result;
  });
  await expect(run()).rejects.toThrow(/snapshot_changed/);
  expect(control.attestSnapshot).not.toHaveBeenCalled();
});
it("rejects disagreement with the Worker's restored control snapshot", async () => {
  const original = control.challengeSnapshot.getMockImplementation();
  control.challengeSnapshot.mockImplementation(async (...args) => ({
    ...(await original(...args)),
    mirror: { ...c.mirror, controlSha256: "f".repeat(64) },
  }));
  await expect(run()).rejects.toThrow(/snapshot_changed/);
  expect(control.attestSnapshot).not.toHaveBeenCalled();
});
it.each(["preparing", "epoch_reserved", "restore_pending", "cancelled"])(
  "rejects %s without requesting a challenge",
  async (state) => {
    selected.state = state;
    delete selected.restoreResult;
    await expect(run()).rejects.toThrow();
    expect(control.challengeSnapshot).not.toHaveBeenCalled();
  },
);
it("stops new reads when its observation window expires", async () => {
  const original = control.challengeSnapshot.getMockImplementation();
  control.challengeSnapshot.mockImplementation(async (...args) => {
    const value = await original(...args);
    vi.spyOn(Date, "now").mockReturnValue(value.expiresAt);
    return value;
  });
  await expect(run()).rejects.toThrow(/snapshot_expired/);
  expect(reader.snapshotQuery).not.toHaveBeenCalled();
  expect(control.attestSnapshot).not.toHaveBeenCalled();
});
it("retains the restore hold when recording the proof has an unknown outcome", async () => {
  control.attestSnapshot.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(run()).rejects.toThrow(/operator_timeout/);
  expect(control.attestSnapshot).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});
it("rejects a changed configuration during capture", async () => {
  let checks = 0;
  reader.assertUnchanged.mockImplementation(async () => {
    if (++checks === 12) throw new Error("database_restore_target_config_changed");
  });
  await expect(run()).rejects.toThrow(/config_changed/);
  expect(control.attestSnapshot).not.toHaveBeenCalled();
});
