import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .sort()
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(new URL(name, directory), "utf8"));
let db: DatabaseSync;
let now: number;
let sequence: number;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  now = 1_000_000;
  sequence = 0;
  db.function("strftime", { varargs: true }, () => String(Math.floor(now / 1000)));
  for (const sql of migrations) db.exec(sql);
  db.exec("UPDATE control SET maintenance=0");
});
afterEach(() => db.close());
function claim() {
  const id = `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
  db.prepare(`INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
    VALUES(?,?,(SELECT epoch FROM control),strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`).run(
    id,
    id,
  );
  return id;
}
function finish(id: string) {
  db.prepare(
    "UPDATE kdf_attempts SET state='finished',finished_at=strftime('%s','now')*1000 WHERE id=?",
  ).run(id);
}
it("bounds the rolling dispatch window at 600 and retains each spent receipt until 65 seconds", () => {
  for (let i = 0; i < 600; i++) finish(claim());
  expect(() => claim()).toThrow("kdf_unavailable");
  now += 64_999;
  expect(() => claim()).toThrow("kdf_unavailable");
  expect(() => db.exec("DELETE FROM kdf_attempts")).toThrow("kdf_receipt_required");
  now += 1;
  expect(claim()).toBeTruthy();
  db.exec("DELETE FROM kdf_attempts WHERE state<>'claimed'");
  expect(db.prepare("SELECT COUNT(*) AS n FROM kdf_attempts").get()!.n).toBe(1);
});
it("counts unknown executions from every epoch toward the global 20-slot bound", () => {
  const ids = Array.from({ length: 20 }, claim);
  expect(() => claim()).toThrow("kdf_unavailable");
  now += 100_000;
  db.exec("UPDATE control SET epoch=2");
  now += 65_000;
  expect(() => claim()).toThrow("kdf_unavailable");
  finish(ids[0]!);
  expect(claim()).toBeTruthy();
  expect(() => claim()).toThrow("kdf_unavailable");
});
it("does not reset recent rate charges when the epoch advances", () => {
  for (let i = 0; i < 600; i++) finish(claim());
  db.exec("UPDATE control SET epoch=2");
  expect(db.prepare("SELECT COUNT(*) AS n FROM kdf_attempts").get()!.n).toBe(600);
  expect(() => claim()).toThrow("kdf_unavailable");
  now += 65_000;
  expect(claim()).toBeTruthy();
});
it("requires a complete cooldown after recovery and rejects dispatch during maintenance", () => {
  db.exec("UPDATE control SET epoch=2,maintenance=1");
  now += 65_000;
  expect(() => claim()).toThrow("kdf_unavailable");
  db.exec("UPDATE control SET maintenance=0,epoch=3");
  now += 64_000;
  expect(() => claim()).toThrow("kdf_unavailable");
  now += 1000;
  expect(claim()).toBeTruthy();
});
it("does not recycle a running slot merely because its dispatch deadline passed", () => {
  const id = claim();
  now += 100_000;
  expect(() => db.prepare("DELETE FROM kdf_attempts WHERE id=?").run(id)).toThrow(
    "kdf_receipt_required",
  );
  finish(id);
  db.prepare("DELETE FROM kdf_attempts WHERE id=?").run(id);
  expect(db.prepare("SELECT COUNT(*) AS n FROM kdf_attempts").get()!.n).toBe(0);
});
it("rejects mutable identity, extended deadlines, repeated completion and terminal insertion", () => {
  const id = claim();
  for (const field of ["id", "dispatch_token", "epoch", "issued_at", "expires_at"])
    expect(() => db.exec(`UPDATE kdf_attempts SET ${field}=${field}||'1'`)).toThrow();
  finish(id);
  expect(() => finish(id)).toThrow("immutable_kdf_attempt");
  expect(() =>
    db
      .prepare(
        `INSERT INTO kdf_attempts SELECT ?,?,epoch,issued_at,expires_at,state,finished_at FROM kdf_attempts`,
      )
      .run(crypto.randomUUID(), crypto.randomUUID()),
  ).toThrow("kdf_unavailable");
});
it("retains rate charges during clock rollback", () => {
  for (let i = 0; i < 600; i++) finish(claim());
  now -= 60_000;
  expect(() => claim()).toThrow("kdf_unavailable");
  expect(() => db.exec("DELETE FROM kdf_attempts")).toThrow("kdf_receipt_required");
});
