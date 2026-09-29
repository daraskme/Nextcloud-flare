import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0073_audio_candidates.sql", dir), "utf8");
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < "0073_")
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  for (const statement of foundationFixture().statements)
    db.prepare(statement.sql).run(...((statement.values as (string | number | null)[]) ?? []));
});
afterEach(() => db.close());
const nodes = () => db.prepare("SELECT * FROM nodes ORDER BY id").all();
it("adds only an index and keeps its visible keyset current through rename, move and hiding", () => {
  const before = nodes();
  db.exec(migration);
  expect(nodes()).toEqual(before);
  const children = () =>
    db
      .prepare(
        "SELECT id,name_ci FROM nodes INDEXED BY nodes_audio_candidates WHERE parent_id='f-d' AND space_id='f-s' AND owner_id='f-u' AND deleted_at IS NULL AND hidden=0 ORDER BY name_ci,id",
      )
      .all();
  expect(children()).toEqual([{ id: "f-f", name_ci: "file" }]);
  db.exec("UPDATE nodes SET name='Renamed',name_ci='renamed' WHERE id='f-f'");
  expect(children()).toEqual([{ id: "f-f", name_ci: "renamed" }]);
  db.exec("UPDATE nodes SET hidden=1 WHERE id='f-f'");
  expect(children()).toEqual([]);
  db.exec("UPDATE nodes SET hidden=0 WHERE id='f-f'");
  expect(children()).toHaveLength(1);
  db.exec("UPDATE nodes SET parent_id='f-r' WHERE id='f-f'");
  expect(children()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("refuses the forward index migration while ordinary admission remains open", () => {
  db.exec("UPDATE control SET maintenance=0");
  const before = nodes();
  expect(() => db.exec(migration)).toThrow();
  expect(nodes()).toEqual(before);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='nodes_audio_candidates'").all(),
  ).toEqual([]);
});
