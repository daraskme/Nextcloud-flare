import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  destinationPrincipal,
  storedDestination,
  type TransferDestination,
  transferDestination,
} from "../../src/auth/transferScope";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { digestJson, operationIntent } from "../../src/jobs/operations";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && f < "0051_")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  for (const prefix of ["owner", "recipient"])
    for (const s of foundationFixture(prefix).statements)
      db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='owner-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,version,disabled_at) VALUES('selected','owner-u','owner-d','internal',1,2,1);
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','owner-s',1,10000,'released');
    INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES('legacy','user','owner-u','as:owner-session','owner-s','node.copy','failed','digest',1,'permit',10000,10000,0,1,1);`);
});
afterEach(() => db.close());
function migrate() {
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && f >= "0051_")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
}
function insert(
  destinationSpace: string | null = "owner-s",
  share: string | null = "selected",
  version: number | null = 1,
  kind = "node.copy",
) {
  db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,selected_share_id,selected_share_version,destination_space_id,destination_share_id,destination_share_version)
    VALUES('transfer','user','recipient-u','as:recipient-session','owner-s',?,'failed','digest',1,'permit',10000,10000,0,1,1,'selected',1,?,?,?)`).run(
    kind,
    destinationSpace,
    share,
    version,
  );
}
const ready = () => db.prepare(RECOVERY_FINAL_QUERY).get(1);
it("adds nullable destinations without changing legacy data or foreign keys", () => {
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((t) => t.type === "table" && !String(t.name).startsWith("sqlite_"))
    .map((t) => String(t.name));
  const columns = Object.fromEntries(
    tables.map((t) => [
      t,
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => String(c.name))
        .join(","),
    ]),
  );
  const snapshot = () =>
    Object.fromEntries(
      tables.map((t) => [t, db.prepare(`SELECT ${columns[t]} FROM ${t} ORDER BY 1`).all()]),
    );
  const before = snapshot();
  migrate();
  expect(snapshot()).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT destination_space_id,destination_share_id,destination_share_version FROM operations",
      )
      .get(),
  ).toEqual({
    destination_space_id: null,
    destination_share_id: null,
    destination_share_version: null,
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(ready()).toBeTruthy();
});
it("accepts stopped historical grants and makes the destination immutable", () => {
  migrate();
  insert();
  expect(ready()).toBeTruthy();
  for (const sql of [
    "destination_share_id=NULL",
    "destination_share_version=2",
    "destination_space_id=NULL",
  ])
    expect(() => db.exec(`UPDATE operations SET ${sql} WHERE op_id='transfer'`)).toThrow();
});
it.each([
  [null, "selected", 1, "node.copy"],
  ["owner-s", null, 1, "node.copy"],
  ["owner-s", "selected", null, "node.copy"],
  ["owner-s", null, null, "node.copy"],
  ["recipient-s", null, null, "node.copy"],
  ["owner-s", "selected", 3, "node.copy"],
  ["owner-s", "selected", 1.5, "node.copy"],
  ["owner-s", "selected", 1, "node.rename"],
] as const)("rejects invalid destination %j/%j/%j for %s", (space, share, version, kind) => {
  migrate();
  expect(() => insert(space, share, version, kind)).toThrow(
    version === 1.5 ? "cannot store REAL value in INTEGER column" : "invalid_transfer_destination",
  );
});
it.each([
  "destination_space_id=NULL",
  "destination_space_id='recipient-s'",
  "destination_share_id=NULL",
  "destination_share_version=NULL",
  "destination_share_version=3",
  "destination_share_id=NULL,destination_share_version=NULL",
  "kind='node.rename'",
])("blocks restored destination corruption: %s", (set) => {
  migrate();
  insert();
  expect(ready()).toBeTruthy();
  db.exec(
    "DROP TRIGGER operations_destination_identity; DROP TRIGGER operation_terminal_immutable; DROP TRIGGER operations_identity;",
  );
  db.exec(`UPDATE operations SET ${set} WHERE op_id='transfer'`);
  expect(ready()).toBeUndefined();
});

it("copies both grants before awaiting and keeps legacy, personal and selected digests distinct", async () => {
  const principal = {
    kind: "user" as const,
    user_id: "owner-u",
    credential_id: "as:owner-session",
    epoch: 1,
  };
  const body = { name: "copied" },
    operands = { sourceNodeId: "owner-f", parentId: "owner-r" };
  const destination = { spaceId: "owner-s", share: { id: "selected", version: 1 } };
  const pending = operationIntent(
    principal,
    "key",
    "owner-s",
    "node.copy",
    body,
    operands,
    destination,
  );
  destination.share.version = 2;
  const selected = await pending;
  expect(selected.destination).toEqual({
    spaceId: "owner-s",
    share: { id: "selected", version: 1 },
  });
  expect(Object.isFrozen(selected.destination)).toBe(true);
  expect(Object.isFrozen(selected.destination!.share)).toBe(true);
  const legacy = await operationIntent(principal, "key", "owner-s", "node.copy", body, operands);
  expect(legacy.digest).toBe(await digestJson({ spaceId: "owner-s", kind: "node.copy", body }));
  const personal = await operationIntent(principal, "key", "owner-s", "node.copy", body, operands, {
    spaceId: "owner-s",
    share: null,
  });
  expect(new Set([legacy.id, personal.id, selected.id]).size).toBe(1);
  expect(new Set([legacy.digest, personal.digest, selected.digest]).size).toBe(3);
  expect(
    destinationPrincipal(
      { ...principal, selected_share: { id: "selected", version: 1 } },
      personal.destination,
    ),
  ).toEqual(principal);
  await expect(
    operationIntent(principal, "key", "owner-s", "node.copy", body, operands, {
      spaceId: "recipient-s",
      share: null,
    }),
  ).rejects.toThrow("invalid_transfer_scope");
});
it.each([
  { destination_space_id: null, destination_share_id: "share", destination_share_version: 1 },
  { destination_space_id: "space", destination_share_id: "share", destination_share_version: null },
  { destination_space_id: "space", destination_share_id: null, destination_share_version: 1 },
  { destination_space_id: "space", destination_share_id: "share", destination_share_version: 0 },
])("rejects incomplete stored destination %j", (row) => {
  expect(() => storedDestination(row)).toThrow();
});
it("rejects scope extension properties and distinguishes absent from explicit personal scope", () => {
  expect(() =>
    transferDestination({ spaceId: "space", share: null, extra: true } as TransferDestination),
  ).toThrow("invalid_transfer_scope");
  expect(
    storedDestination({
      destination_space_id: null,
      destination_share_id: null,
      destination_share_version: null,
    }),
  ).toBeUndefined();
  expect(
    storedDestination({
      destination_space_id: "space",
      destination_share_id: null,
      destination_share_version: null,
    }),
  ).toEqual({ spaceId: "space", share: null });
});
