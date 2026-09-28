import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COPY_MULTIPART_ABORT_FROM, COPY_MULTIPART_ABORT_READY } from "../../src/db/r2CopyAbort";
import { type R2WriteRequest, r2WriteSourceRef, validateR2Write } from "../../src/db/r2Write";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
describe("copy abort migration", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of readdirSync(directory)
      .filter((n) => n.endsWith(".sql") && n < "0058_")
      .sort())
      db.exec(readFileSync(new URL(name, directory), "utf8"));
    for (const s of foundationFixture("source").statements)
      db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  });
  afterEach(() => db.close());
  const migrate = () =>
    db.exec(readFileSync(new URL("0058_copy_multipart_abort.sql", directory), "utf8"));
  it("preserves every old table column and row and keeps the FK graph intact", () => {
    const old = db
      .prepare("PRAGMA table_list")
      .all()
      .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"))
      .map((t) => ({
        name: String(t.name),
        columns: db
          .prepare(`PRAGMA table_info(${t.name})`)
          .all()
          .map((c) => String(c.name))
          .join(","),
        rows: db.prepare(`SELECT * FROM ${t.name}`).all(),
      }));
    migrate();
    for (const t of old)
      expect(db.prepare(`SELECT ${t.columns} FROM ${t.name}`).all()).toEqual(t.rows);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it.each(["admission", "restore", "backup"])("refuses migration during %s", (phase) => {
    if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
    if (phase === "restore")
      db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
    if (phase === "backup")
      db.exec(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
    SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control;
    UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1;`);
    expect(migrate).toThrow();
    expect(
      db
        .prepare("PRAGMA table_info(copy_multipart_uploads)")
        .all()
        .map((r) => r.name),
    ).not.toContain("abort_attempt");
  });
  it("keeps prepare/dispatch/settlement proofs aligned and indexes both kinds of terminal history", () => {
    migrate();
    for (const name of ["copy_abort_prepare", "copy_abort_dispatch", "copy_cleanup_aborted"])
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql).toContain(
        COPY_MULTIPART_ABORT_READY,
      );
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 ${COPY_MULTIPART_ABORT_FROM} WHERE cb.job_id=? AND cb.source_blob_id=? AND ${COPY_MULTIPART_ABORT_READY}`,
      )
      .all("job", "blob")
      .map((r) => String(r.detail));
    expect(
      plan.filter((s) =>
        /SEARCH w(?: EXISTS)? USING INDEX r2_write_source \(kind=\? AND source_ref=\?\)/.test(s),
      ),
    ).toHaveLength(2);
    expect(
      plan.filter((s) =>
        s.includes("SEARCH w USING INDEX r2_write_not_started_source (kind=? AND source_ref=?)"),
      ),
    ).toHaveLength(2);
    expect(() =>
      db.exec(
        "INSERT INTO copy_cleanup_receipts VALUES('job','blob','dst','pin','r',3,'aborted',1,1)",
      ),
    ).toThrow("copy_abort_unconfirmed");
  });
});
const request = (): R2WriteRequest => ({
  id: crypto.randomUUID(),
  epoch: 2,
  ownerId: "owner",
  kind: "multipart.abort",
  key: "u/owner/b/blob",
  deadline: Date.now() + 4000,
  abort: {
    source: "copy",
    jobId: "copy_" + "a".repeat(64),
    sourceBlobId: "source",
    attemptId: crypto.randomUUID(),
    r2UploadId: "handle",
    maintenance: true,
  },
});
it("binds a copy abort source to its job, source blob and immutable attempt", () => {
  const r = request();
  expect(() => validateR2Write(r)).not.toThrow();
  expect(JSON.parse(r2WriteSourceRef(r)!)).toEqual([
    "copy",
    r.abort!.jobId,
    "source",
    r.abort!.attemptId,
  ]);
});
it.each([
  { jobId: "job" },
  { sourceBlobId: 123 },
  { sourceBlobId: "" },
  { sourceBlobId: "a/b" },
  { uploadId: "up_" + "a".repeat(64) },
  { sourceEpoch: 1 },
  { handleId: crypto.randomUUID() },
  { scanRound: crypto.randomUUID() },
  { knownUploadId: null },
  { binding: {} },
  { attemptId: "bad" },
  { r2UploadId: "" },
  { maintenance: 1 },
])("rejects malformed or mixed copy abort identity %j", (extra) => {
  const r = request();
  r.abort = { ...r.abort!, ...extra } as R2WriteRequest["abort"] & {};
  expect(() => validateR2Write(r)).toThrow("invalid_r2_write");
});
