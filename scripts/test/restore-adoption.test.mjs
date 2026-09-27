import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { restoreAdoptionBatch } from "../../packages/worker/src/db/restoreAdoption.ts";
import { restoredControlDigest } from "../../packages/worker/src/db/restoreSnapshot.ts";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";
import { initialize, migrations } from "../backup/snapshot.mjs";
import { adoptRestoreEpoch } from "../restore/adoption.mjs";

let db, selected, reader, control, c;
const execute = (batch) => {
  db.exec("BEGIN");
  try {
    for (const s of batch) db.prepare(s.sql).run(...(s.values ?? []));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
beforeEach(async () => {
  db = initialize(":memory:", await migrations());
  const at = Date.now();
  selected = {
    id: randomUUID(),
    epoch: 2,
    newEpoch: 3,
    state: "snapshot_verified",
    createdAt: at - 1000,
    source: { kind: "time_travel", bookmark: "selected" },
    snapshotVerifiedAt: at,
    restoreResult: { bookmark: "restored", previousBookmark: "before" },
  };
  const accountId = "a".repeat(32);
  reader = {
    target: { mode: "remote", accountId, databaseId: randomUUID() },
    blobsTarget: { accountId, bucket: "blobs", jurisdiction: "default" },
    backupsTarget: { accountId, bucket: "backups", jurisdiction: "default" },
    assertUnchanged: vi.fn(async () => {}),
    snapshotQuery: vi.fn(async (sql) => db.prepare(sql).all()),
  };
  control = {
    inspect: vi.fn(async () => ({ ...selected })),
    beginAdoption: vi.fn(async () => {
      const token = randomUUID(),
        batch = restoreAdoptionBatch(db.prepare("SELECT * FROM control").get(), 3, token, at);
      c = {
        validator: "restore-epoch-adoption-v1",
        id: selected.id,
        epoch: 2,
        newEpoch: 3,
        targets: {
          target: reader.target,
          blobs: reader.blobsTarget,
          backups: reader.backupsTarget,
        },
        token,
        kdfNotBefore: batch.expected.kdf_not_before,
        controlSha256: await restoredControlDigest([batch.expected]),
      };
      execute(batch.statements);
      return c;
    }),
    attestAdoption: vi.fn(async () => ({ ...selected, state: "epoch_adopted" })),
  };
});
afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
});
const run = () => adoptRestoreEpoch({ epoch: 2, id: selected.id, reader, control });

it("independently reads the atomic marker before attestation and strips it from output", async () => {
  const saved = await run();
  expect(saved.state).toBe("epoch_adopted");
  expect(JSON.stringify(saved)).not.toContain(c.token);
  expect(control.beginAdoption.mock.invocationCallOrder[0]).toBeLessThan(
    reader.snapshotQuery.mock.invocationCallOrder[0],
  );
  expect(reader.snapshotQuery.mock.invocationCallOrder[0]).toBeLessThan(
    control.attestAdoption.mock.invocationCallOrder[0],
  );
  expect(control.attestAdoption).toHaveBeenCalledWith(2, selected.id, c);
});
it.each(["epoch", "admission_token", "maintenance", "updated_at", "kdf_not_before"])(
  "refuses a different independently observed %s",
  async (key) => {
    reader.snapshotQuery.mockImplementation(async () => [
      {
        ...db.prepare("SELECT * FROM control").get(),
        [key]: key === "admission_token" ? randomUUID() : key === "epoch" ? 1 : 0,
      },
    ]);
    await expect(run()).rejects.toThrow(/mirror_conflict/);
    expect(control.attestAdoption).not.toHaveBeenCalled();
  },
);
it("never retries an unknown dispatch", async () => {
  control.beginAdoption.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(run()).rejects.toThrow(/timeout/);
  expect(control.beginAdoption).toHaveBeenCalledTimes(1);
  expect(reader.snapshotQuery).not.toHaveBeenCalled();
  expect(control.attestAdoption).not.toHaveBeenCalled();
});
it("returns an already adopted status without another write", async () => {
  selected.state = "epoch_adopted";
  expect(await run()).toEqual(selected);
  expect(control.beginAdoption).not.toHaveBeenCalled();
});
it("refuses a configuration change during independent readback", async () => {
  reader.snapshotQuery.mockImplementation(async (sql) => {
    reader.assertUnchanged.mockRejectedValue(new Error("database_restore_target_changed"));
    return db.prepare(sql).all();
  });
  await expect(run()).rejects.toThrow(/target_changed/);
  expect(control.attestAdoption).not.toHaveBeenCalled();
});
it.each([37, 39, 40, 46])(
  "adopts a historical schema prefix %i without applying migrations",
  async (count) => {
    db.close();
    db = initialize(":memory:", (await migrations()).slice(0, count));
    const schema = db.prepare("SELECT sql FROM sqlite_schema ORDER BY type,name").all();
    await run();
    expect(db.prepare("SELECT epoch,maintenance,gc_paused FROM control").get()).toEqual({
      epoch: 3,
      maintenance: 1,
      gc_paused: 1,
    });
    expect(db.prepare("SELECT sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(schema);
  },
);
it.each(["backup", "restore"])(
  "clears only the restored %s freeze in the same atomic stop",
  async (kind) => {
    if (kind === "restore")
      db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID());
    else {
      const token = randomUUID();
      db.prepare(
        "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',1,?)",
      ).run(randomUUID(), token);
      db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token);
    }
    const backups = db.prepare("SELECT * FROM backup_runs").all();
    await run();
    expect(
      db.prepare("SELECT backup_token,backup_frozen,restore_freeze_token FROM control").get(),
    ).toEqual({ backup_token: null, backup_frozen: 0, restore_freeze_token: null });
    expect(db.prepare("SELECT * FROM backup_runs").all()).toEqual(backups);
  },
);
it("rolls back the complete thaw if the exact snapshot CAS fails", () => {
  const original = db.prepare("SELECT * FROM control").get();
  const batch = restoreAdoptionBatch(original, 3, randomUUID(), Date.now());
  db.prepare("UPDATE control SET updated_at=updated_at+1").run();
  const changed = db.prepare("SELECT * FROM control").get();
  expect(() => execute(batch.statements)).toThrow();
  expect(db.prepare("SELECT * FROM control").get()).toEqual(changed);
});
it("preserves terminal operations and native execution evidence while revoking old permits and claims", async () => {
  const fixture = foundationFixture("adoption", Date.now() - 1000);
  for (const s of fixture.statements) db.prepare(s.sql).run(...(s.values ?? []));
  for (const state of ["committed", "failed", "claimed"]) {
    db.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,1,?)",
    ).run(state, fixture.ids.space, state === "claimed" ? "open" : "released");
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
  const terminal = db
    .prepare("SELECT * FROM operations WHERE state<>'claimed' ORDER BY op_id")
    .all();
  db.exec("UPDATE control SET maintenance=0,kdf_not_before=0");
  db.prepare(
    "INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at) VALUES(?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
  ).run(randomUUID(), randomUUID());
  db.prepare(
    "INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state) VALUES(?,?,1,'fixture','empty.put','fixture',strftime('%s','now')*1000+5000,strftime('%s','now')*1000,'pending')",
  ).run(randomUUID(), randomUUID());
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,'waiting',?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
  ).run(randomUUID(), fixture.ids.space);
  const kdf = db.prepare("SELECT * FROM kdf_attempts").all(),
    r2 = db.prepare("SELECT * FROM r2_write_attempts").all();
  await run();
  expect(db.prepare("SELECT * FROM kdf_attempts").all()).toEqual(kdf);
  expect(db.prepare("SELECT * FROM r2_write_attempts").all()).toEqual(r2);
  expect(
    db.prepare("SELECT state FROM mutation_admissions WHERE permit_id='waiting'").get().state,
  ).toBe("closed");
  expect(
    db.prepare("SELECT * FROM operations WHERE op_id<>'claimed' ORDER BY op_id").all(),
  ).toEqual(terminal);
  expect(db.prepare("SELECT state,error_code FROM operations WHERE op_id='claimed'").get()).toEqual(
    { state: "failed", error_code: "stale_epoch" },
  );
  expect(db.prepare("SELECT state FROM permits WHERE permit_id='claimed'").get().state).toBe(
    "revoked",
  );
});

it.each(["backup", "restore"])(
  "rolls back the %s thaw and stop when a later statement fails",
  (kind) => {
    if (kind === "restore")
      db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID());
    else {
      const token = randomUUID();
      db.prepare(
        "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',1,?)",
      ).run(randomUUID(), token);
      db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token);
    }
    const before = db.prepare("SELECT * FROM control").get();
    const batch = restoreAdoptionBatch(before, 3, randomUUID(), Date.now());
    expect(() =>
      execute([...batch.statements, { sql: "INSERT INTO _assert(v) VALUES(1)" }]),
    ).toThrow();
    expect(db.prepare("SELECT * FROM control").get()).toEqual(before);
  },
);

it("accepts only extensions of the D1-clock KDF cooldown", async () => {
  reader.snapshotQuery.mockImplementation(async (sql) => {
    db.exec("UPDATE control SET kdf_not_before=kdf_not_before+60000");
    return db.prepare(sql).all();
  });
  expect((await run()).state).toBe("epoch_adopted");
});
