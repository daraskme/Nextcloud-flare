import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("also enforces CHECK rollback and foreign keys in native SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(readFileSync(new URL("../fixtures/d1-schema.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../fixtures/d1-seed.sql", import.meta.url), "utf8"));
    db.exec("BEGIN");
    expect(() => db.exec("UPDATE users SET used_bytes=10; INSERT INTO _assert VALUES(1)")).toThrow(
      /CHECK/,
    );
    // Native SQLite exec is NOT D1.batch; an explicit transaction rollback is required here.
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT used_bytes FROM users").get()?.used_bytes).toBe(0);
    expect(() => db.exec("UPDATE nodes SET space_id='missing'")).toThrow(/FOREIGN KEY/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
