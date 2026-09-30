import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import {
  OPERATIONS,
  SCOPES,
  SINGLE_UPLOAD_TRANSITIONS,
  STATES,
  SYSTEM_OPERATIONS,
} from "@next-cloud-flare/shared/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportTables, purgeOrder } from "../../src/db/schemaContract";
import { deletionOrder, type ForeignKey } from "../../src/db/schemaGraph";
import { ROUTES } from "../../src/routes/manifest";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
const fixture = foundationFixture();
const migrationDir = new URL("../../migrations/", import.meta.url);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(new URL(file, migrationDir), "utf8"));
  }
  for (const statement of fixture.statements)
    db.prepare(statement.sql).run(...((statement.values as (string | number | null)[]) ?? []));
});
afterEach(() => db.close());

it("bounds the durable admission revision and transition token without opening legacy control rows", () => {
  expect(
    db
      .prepare("SELECT maintenance,gc_paused,admission_revision,admission_token FROM control")
      .get(),
  ).toEqual({ maintenance: 1, gc_paused: 1, admission_revision: 0, admission_token: null });
  for (const invalid of [-1, 0.5, 9007199254740992])
    expect(() => db.prepare("UPDATE control SET admission_revision=?").run(invalid)).toThrow();
  for (const invalid of ["", "x".repeat(129)])
    expect(() => db.prepare("UPDATE control SET admission_token=?").run(invalid)).toThrow();
  db.prepare("UPDATE control SET admission_revision=9007199254740991,admission_token=?").run(
    crypto.randomUUID(),
  );
});

it("migrates all 67 normal tables with strict types, explicit PK nullability and a complete FK graph", () => {
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((row) => row.type === "table" && !String(row.name).startsWith("sqlite_"));
  expect(tables).toHaveLength(67);
  for (const table of tables) {
    expect(table.strict).toBe(1);
    const columns = db.prepare(`PRAGMA table_info('${table.name}')`).all();
    for (const column of columns.filter((column) => column.pk && column.type === "TEXT"))
      expect(column.notnull).toBe(1);
    for (const fk of db.prepare(`PRAGMA foreign_key_list('${table.name}')`).all()) {
      const indexes = db
        .prepare(`PRAGMA index_list('${table.name}')`)
        .all()
        .filter((index) => !index.partial);
      expect(
        indexes.some(
          (index) => db.prepare(`PRAGMA index_info('${index.name}')`).all()[0]?.name === fk.from,
        ),
        `${table.name}.${fk.from} FK needs index`,
      ).toBe(true);
    }
  }
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("upgrades existing uploads to the private source without changing their storage holds", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(migrationDir)
      .filter((f) => f.endsWith(".sql") && f < "0035_")
      .sort())
      legacy.exec(readFileSync(new URL(file, migrationDir), "utf8"));
    for (const s of fixture.statements)
      legacy.prepare(s.sql).run(...((s.values as (string | number | null)[]) ?? []));
    legacy.exec(
      "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('legacy-res','f-u',3,'reserved',10000,1)",
    );
    legacy.exec(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
      VALUES('legacy','f-u','f-s','f-d','f-b','as:f-session','legacy-res','single','receiving',3,'hash',1,1,10000,1)`);
    const before = legacy.prepare("SELECT * FROM uploads WHERE id='legacy'").get();
    legacy.exec(readFileSync(new URL("0035_dav_upload_source.sql", migrationDir), "utf8"));
    expect(legacy.prepare("SELECT * FROM uploads WHERE id='legacy'").get()).toEqual({
      ...before,
      source: "private",
    });
    expect(legacy.prepare("SELECT reserved_bytes FROM users WHERE id='f-u'").get()).toEqual({
      reserved_bytes: 3,
    });
    expect(() => legacy.exec("UPDATE uploads SET source='dav' WHERE id='legacy'")).toThrow(
      "immutable_upload_source",
    );
  } finally {
    legacy.close();
  }
});

it("rejects a DAV ledger without a bound app-password operation", () => {
  db.exec(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('res','f-u',3,'reserved',10000,1)",
  );
  expect(() =>
    db.exec(`INSERT INTO uploads(id,source,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
      capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,write_attempt_id,write_lease_expires_at)
      VALUES('dav_missing','dav','f-u','f-s','f-d','f-b','as:f-session','res','single','receiving',3,'internal:dav',1,1,10000,1,'file','attempt',9000)`),
  ).toThrow("invalid_dav_upload_source");
});

it("limits each owner to 64 unexpired active budgets across insert and reactivation", () => {
  const future = Date.now() + 600_000;
  const past = Date.now() - 2_000;
  const insert = db.prepare(
    "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,'f-u','f-u',1,?,?)",
  );
  for (let i = 0; i < 64; i++) insert.run(`budget-${i}`, future, "active");
  expect(() => insert.run("budget-64", future, "active")).toThrow(/owner_budget_limit/);
  insert.run("expired-budget", past, "active");
  insert.run("revoked-budget", future, "revoked");
  expect(() =>
    db.exec("UPDATE budgets SET expires_at=9999999999999 WHERE id='expired-budget'"),
  ).toThrow(/owner_budget_limit/);
  expect(() => db.exec("UPDATE budgets SET state='active' WHERE id='revoked-budget'")).toThrow(
    /owner_budget_limit/,
  );
  db.exec("UPDATE budgets SET state='revoked' WHERE id='budget-0'");
  db.exec("UPDATE budgets SET state='active' WHERE id='revoked-budget'");
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM budgets WHERE owner_id='f-u' AND state='active' AND expires_at>?",
      )
      .get(Date.now()),
  ).toMatchObject({ n: 64 });
});

it("derives the purge order from every FK and excludes FTS virtual/shadow tables from export", () => {
  const tables = exportTables.map((name) => ({
    name,
    foreignKeys: db.prepare(`PRAGMA foreign_key_list('${name}')`).all() as unknown as ForeignKey[],
  }));
  expect(deletionOrder(tables)).toEqual(purgeOrder);
  expect(exportTables).toContain("search_index");
  expect(exportTables.some((name) => String(name).startsWith("search_fts"))).toBe(false);
  for (const table of tables)
    for (const fk of table.foreignKeys) {
      if (fk.table !== table.name)
        expect(purgeOrder.indexOf(table.name)).toBeLessThan(
          purgeOrder.indexOf(fk.table as (typeof purgeOrder)[number]),
        );
    }
});

it("keeps SQL scope and operation catalogues equal to their shared contracts", () => {
  expect(
    db
      .prepare("SELECT name FROM scopes ORDER BY name")
      .all()
      .map((row) => row.name),
  ).toEqual([...SCOPES].sort());
  expect(
    db
      .prepare("SELECT name FROM operation_kinds ORDER BY name")
      .all()
      .map((row) => row.name),
  ).toEqual([...Object.keys(OPERATIONS), ...SYSTEM_OPERATIONS].sort());
  expect(
    new Set(ROUTES.map((route) => `${route.host} ${route.method} ${route.template}`)).size,
  ).toBe(ROUTES.length);
  for (const route of ROUTES)
    expect(OPERATIONS).toHaveProperty(route.operation.replaceAll(".", "\\."));
});

describe("tree guards", () => {
  it.each([
    "UPDATE nodes SET parent_id='f-f' WHERE id='f-d'",
    "UPDATE nodes SET parent_id='f-d' WHERE id='f-d'",
    "UPDATE nodes SET parent_id='missing' WHERE id='f-d'",
    "UPDATE nodes SET name='renamed' WHERE id='f-r'",
    "DELETE FROM nodes WHERE id='f-r'",
    "UPDATE nodes SET owner_id='missing' WHERE id='f-d'",
    "UPDATE spaces SET root_node_id='f-d' WHERE id='f-s'",
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES('collision','f-s','f-u','f-r','FOLDER','folder','folder',1,1)",
  ])("rejects invariant violation: %s", (sql) => {
    expect(() => db.exec(sql)).toThrow();
  });

  it("allows depth 64 and rejects depth 65 and a move that makes a subtree too deep", () => {
    const insert = db.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,'f-s','f-u',?,? ,?,'folder',1,1)",
    );
    let parent = "f-r";
    for (let depth = 1; depth <= 64; depth++) {
      const id = `deep${depth}`;
      insert.run(id, parent, id, id);
      parent = id;
    }
    expect(() => insert.run("too-deep", parent, "too-deep", "too-deep")).toThrow(/depth/);
    expect(() => db.exec("UPDATE nodes SET parent_id='deep63' WHERE id='f-d'")).toThrow(/depth/);
    expect(() => db.exec("UPDATE nodes SET parent_id='deep10' WHERE id='deep5'")).toThrow(/cycle/);
  });

  it("detaches a deleted child from a purged parent without reviving it", () => {
    db.exec(
      "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES('trash','f-u','f-s','f-f','trashed',1,1)",
    );
    db.exec("UPDATE nodes SET deleted_at=1,deleted_op_id='trash' WHERE id='f-f'");
    db.exec("UPDATE nodes SET parent_id=NULL WHERE id='f-f'");
    db.exec("DELETE FROM nodes WHERE id='f-d'");
    expect(db.prepare("SELECT parent_id,deleted_at FROM nodes WHERE id='f-f'").get()).toEqual({
      parent_id: null,
      deleted_at: 1,
    });
    expect(() =>
      db.exec("UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL WHERE id='f-f'"),
    ).toThrow();
    db.exec("UPDATE nodes SET parent_id='f-r',deleted_at=NULL,deleted_op_id=NULL WHERE id='f-f'");
  });
});

it("protects the last enabled admin and permits promotion before demotion", () => {
  expect(() => db.exec("UPDATE users SET disabled_at=1 WHERE id='f-u'")).toThrow(/last_admin/);
  expect(() => db.exec("UPDATE users SET role='member' WHERE id='f-u'")).toThrow(/last_admin/);
  expect(() => db.exec("DELETE FROM users WHERE id='f-u'")).toThrow(/last_admin/);
  db.exec(
    "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES('other','i','s','e','app_admin',0,1)",
  );
  db.exec("UPDATE users SET role='member' WHERE id='f-u'");
});

it("refuses deletion while referenced and makes deleting irreversible", () => {
  expect(() => db.exec("UPDATE blobs SET state='deleting' WHERE id='f-b'")).toThrow(
    /blob_referenced/,
  );
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  db.exec("UPDATE blobs SET state='deleting' WHERE id='f-b'");
  expect(() => db.exec("UPDATE blobs SET state='committed' WHERE id='f-b'")).toThrow(
    /blob_unrecoverable/,
  );
  expect(() => db.exec("UPDATE nodes SET current_blob_id='f-b' WHERE id='f-f'")).toThrow(
    /blob_unrecoverable/,
  );
  expect(() => db.exec("INSERT INTO node_versions VALUES('v','f-f','f-b',1,1)")).toThrow(
    /blob_unrecoverable/,
  );
  expect(() => db.exec("INSERT INTO blob_pins VALUES('p','f-b','backup',NULL,1)")).toThrow(
    /blob_unrecoverable/,
  );
});

it("requires a real credential FK for derived content sessions", () => {
  expect(() =>
    db.exec("INSERT INTO credentials(id,kind,session_id) VALUES('as:missing','access','missing')"),
  ).toThrow(/FOREIGN KEY/);
  expect(() =>
    db.exec("INSERT INTO credentials(id,kind,session_id) VALUES('spoof','access','f-session')"),
  ).toThrow();
});

it("rebuilds external-content FTS from the export base table", () => {
  db.exec(
    "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES('f-f','f-s','hello','he el ll lo','v1',1)",
  );
  db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
  expect(
    db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'hello'").all(),
  ).toHaveLength(1);
});

it.each(
  STATES.singleUpload.flatMap((from) => STATES.singleUpload.map((to) => [from, to] as const)),
)("enforces single upload transition %s → %s", (from, to) => {
  db.exec(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('res','f-u',3,'reserved',10000,1)",
  );
  db.prepare(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
      VALUES('upload','f-u','f-s','f-d','f-b','as:f-session','res','single',?,3,'hash',1,1,10000,1)`).run(
    from,
  );
  const update = () => db.prepare("UPDATE uploads SET state=? WHERE id='upload'").run(to);
  if (from === to || (SINGLE_UPLOAD_TRANSITIONS[from] as readonly string[]).includes(to))
    expect(update).not.toThrow();
  else expect(update).toThrow(/invalid_upload_transition/);
});

it("cannot un-revoke a session or rebind an existing credential", () => {
  db.exec("UPDATE sessions SET revoked_at=1 WHERE id='f-session'");
  expect(() => db.exec("UPDATE sessions SET revoked_at=NULL WHERE id='f-session'")).toThrow(
    /revoked_session/,
  );
  expect(() => db.exec("UPDATE credentials SET id='as:other' WHERE id='as:f-session'")).toThrow(
    /immutable_credential/,
  );
});

it("rejects a password record with a missing KDF iteration field", () => {
  expect(() =>
    db.exec(`INSERT INTO app_passwords(id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
    VALUES('password','f-u','test','hash','salt','PBKDF2-SHA256','{}','key',1,10000)`),
  ).toThrow(/CHECK/);
});

it("retains credential tombstones on purge without widening a scoped password", () => {
  db.exec(`INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
    VALUES('pw','f-u','f-d','test','hash','salt','PBKDF2-SHA256','{"iterations":100000}','key',1,10000)`);
  db.exec("INSERT INTO credentials(id,kind,app_password_id) VALUES('ap:pw','app_password','pw')");
  expect(() => db.exec("UPDATE app_passwords SET root_node_id=NULL WHERE id='pw'")).toThrow(
    /revoke_before_scope_detach/,
  );
  db.exec("UPDATE app_passwords SET root_node_id=NULL,revoked_at=1 WHERE id='pw'");
  db.exec("DELETE FROM nodes WHERE id='f-f'; DELETE FROM nodes WHERE id='f-d'");
  expect(db.prepare("SELECT id FROM credentials WHERE id='ap:pw'").get()?.id).toBe("ap:pw");
  expect(() => db.exec("UPDATE app_passwords SET revoked_at=NULL WHERE id='pw'")).toThrow(
    /revoked_credential/,
  );
});
