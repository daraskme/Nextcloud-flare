import { expectedPartBytes, multipartPlan, UPLOAD_LIMITS } from "./uploadPlan";

type State = "created" | "uploading" | "completing" | "aborting" | "expired" | "failed";
interface UploadRow extends Record<string, SqlStorageValue> {
  upload_id: string;
  epoch: number;
  declared_bytes: number;
  part_bytes: number;
  part_count: number;
  r2_upload_id: string;
  state: State;
  data_calls: number;
  data_bytes: number;
  control_calls: number;
  cleanup_calls: number;
  created_at: number;
  expires_at: number;
  last_progress_at: number;
  cleanup_pending: number;
  error_code: string | null;
}
interface AttemptRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  part_number: number;
  expected_bytes: number;
  state: "in_flight" | "completed" | "not_started" | "unknown";
  lease_expires_at: number;
  etag: string | null;
  sha256: string | null;
}
export interface MultipartIdentity {
  readonly uploadId: string;
  readonly epoch: number;
  readonly declaredBytes: number;
  readonly partBytes: number;
  readonly r2UploadId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface PartLease {
  /** Only 'dispatch' authorizes a new R2 call. A replay must never dispatch again. */
  readonly disposition: "dispatch" | "in_flight" | "completed" | "not_started";
  readonly attemptId: string;
  readonly partNumber: number;
  readonly expectedBytes: number;
  readonly expiresAt: number;
}
export type PartOutcome =
  | {
      readonly kind: "completed";
      readonly bytes: number;
      readonly etag: string;
      readonly sha256: string;
    }
  // This is only valid when uploadPart has NEVER been called for this attempt.
  | { readonly kind: "not_started" }
  | { readonly kind: "unknown" };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const accepting = (state: State) => state === "created" || state === "uploading";
function timestamp(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_upload_time");
}

/**
 * Internal SQLite journal, not an authorization service or an R2 executor.
 * UploadDO supplies a D1-authorized identity and mirrors dirty rows before returning
 * dispatch. This class itself never grants authorization or executes R2 calls.
 */
export class MultipartLedger {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS multipart_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),upload_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,declared_bytes INTEGER NOT NULL,part_bytes INTEGER NOT NULL,
      part_count INTEGER NOT NULL,r2_upload_id TEXT NOT NULL,state TEXT NOT NULL,
      data_calls INTEGER NOT NULL DEFAULT 0,data_bytes INTEGER NOT NULL DEFAULT 0,
      control_calls INTEGER NOT NULL DEFAULT 0,cleanup_calls INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_progress_at INTEGER NOT NULL,
      cleanup_pending INTEGER NOT NULL DEFAULT 0,error_code TEXT);
      CREATE TABLE IF NOT EXISTS multipart_attempts(
      attempt_id TEXT PRIMARY KEY,part_number INTEGER NOT NULL,expected_bytes INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('in_flight','completed','not_started','unknown')),
      lease_expires_at INTEGER NOT NULL,etag TEXT,sha256 TEXT);
      CREATE INDEX IF NOT EXISTS multipart_attempt_part ON multipart_attempts(part_number);
      CREATE INDEX IF NOT EXISTS multipart_attempt_state ON multipart_attempts(state,lease_expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS multipart_active_part ON multipart_attempts(part_number)
        WHERE state IN ('in_flight','completed','unknown');
      CREATE TABLE IF NOT EXISTS multipart_mirror(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO multipart_mirror VALUES(1,1);
      CREATE TABLE IF NOT EXISTS multipart_dirty(part_number INTEGER PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS multipart_state_insert AFTER INSERT ON multipart_state
        BEGIN UPDATE multipart_mirror SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS multipart_state_update AFTER UPDATE ON multipart_state
        BEGIN UPDATE multipart_mirror SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS multipart_attempt_insert AFTER INSERT ON multipart_attempts
        BEGIN UPDATE multipart_mirror SET revision=revision+1;
        INSERT OR IGNORE INTO multipart_dirty VALUES(NEW.part_number); END;
      CREATE TRIGGER IF NOT EXISTS multipart_attempt_update AFTER UPDATE ON multipart_attempts
        BEGIN UPDATE multipart_mirror SET revision=revision+1;
        INSERT OR IGNORE INTO multipart_dirty VALUES(NEW.part_number); END;`);
  }

  #row(): UploadRow | undefined {
    return this.storage.sql.exec<UploadRow>("SELECT * FROM multipart_state").toArray()[0];
  }

  #required(epoch: number): UploadRow {
    const row = this.#row();
    if (!row) throw new Error("upload_not_initialized");
    if (row.epoch !== epoch) throw new Error("upload_epoch_conflict");
    return row;
  }

  initialize(identity: MultipartIdentity, now: number): void {
    timestamp(now);
    const plan = multipartPlan(identity.declaredBytes, identity.partBytes);
    if (
      !ID.test(identity.uploadId) ||
      !Number.isSafeInteger(identity.epoch) ||
      identity.epoch < 1 ||
      !identity.r2UploadId ||
      identity.r2UploadId.length > 2048 ||
      !Number.isSafeInteger(identity.createdAt) ||
      identity.createdAt < 0 ||
      identity.createdAt > now ||
      !Number.isSafeInteger(identity.expiresAt) ||
      identity.expiresAt <= identity.createdAt ||
      identity.expiresAt - identity.createdAt > UPLOAD_LIMITS.lifetimeMs
    )
      throw new Error("invalid_upload_identity");
    const existing = this.#row();
    if (existing) {
      if (
        existing.upload_id !== identity.uploadId ||
        existing.epoch !== identity.epoch ||
        existing.declared_bytes !== identity.declaredBytes ||
        existing.part_bytes !== identity.partBytes ||
        existing.r2_upload_id !== identity.r2UploadId ||
        existing.created_at !== identity.createdAt ||
        existing.expires_at !== identity.expiresAt
      )
        throw new Error("upload_identity_conflict");
      this.advance(now);
      return;
    }
    if (identity.expiresAt <= now || identity.createdAt + UPLOAD_LIMITS.idleMs <= now)
      throw new Error("upload_expired");
    this.storage.sql.exec(
      `INSERT INTO multipart_state(singleton,upload_id,epoch,declared_bytes,part_bytes,
        part_count,r2_upload_id,state,created_at,expires_at,last_progress_at)
        VALUES(1,?,?,?,?,?,?,'created',?,?,?)`,
      identity.uploadId,
      identity.epoch,
      plan.declaredBytes,
      plan.partBytes,
      plan.partCount,
      identity.r2UploadId,
      identity.createdAt,
      identity.expiresAt,
      identity.createdAt,
    );
  }

  #stop(state: "aborting" | "expired" | "failed", reason: string) {
    this.storage.sql.exec(
      "UPDATE multipart_state SET state=?,cleanup_pending=1,error_code=? WHERE singleton=1",
      state,
      reason,
    );
    // In-flight I/O is never reusable, even if its success arrives after this fence.
    this.storage.sql.exec("UPDATE multipart_attempts SET state='unknown' WHERE state='in_flight'");
  }

  /** Lease expiry means unknown R2 outcome, never permission to retry that part. */
  advance(now: number): void {
    timestamp(now);
    this.storage.transactionSync(() => {
      const row = this.#row();
      if (!row || !accepting(row.state)) return;
      if (
        this.storage.sql
          .exec(
            "SELECT 1 FROM multipart_attempts WHERE state='in_flight' AND lease_expires_at<=? LIMIT 1",
            now,
          )
          .toArray().length
      )
        this.#stop("aborting", "part_outcome_unknown");
      else if (row.expires_at <= now || row.last_progress_at + UPLOAD_LIMITS.idleMs <= now)
        this.#stop("expired", "upload_expired");
    });
  }

  claim(
    epoch: number,
    partNumber: number,
    attemptId: string,
    bytes: number,
    now: number,
  ): PartLease {
    timestamp(now);
    this.#required(epoch);
    if (!ID.test(attemptId)) throw new Error("invalid_attempt_id");
    // Persist expiry before any later rejection; throwing inside that transaction would undo it.
    this.advance(now);
    return this.storage.transactionSync(() => {
      const row = this.#required(epoch);
      if (!accepting(row.state)) throw new Error("upload_not_accepting_parts");
      const expected = expectedPartBytes(
        {
          declaredBytes: row.declared_bytes,
          partBytes: row.part_bytes,
          partCount: row.part_count,
        },
        partNumber,
      );
      if (bytes !== expected) throw new Error("part_size_mismatch");
      const existing = this.storage.sql
        .exec<AttemptRow>("SELECT * FROM multipart_attempts WHERE attempt_id=?", attemptId)
        .toArray()[0];
      if (existing) {
        if (existing.part_number !== partNumber || existing.state === "unknown")
          throw new Error("attempt_conflict");
        return {
          disposition: existing.state,
          attemptId,
          partNumber,
          expectedBytes: expected,
          expiresAt: existing.lease_expires_at,
        };
      }
      const attempts = this.storage.sql
        .exec<{ count: number; busy: number }>(
          `SELECT COUNT(*) AS count,COALESCE(SUM(state<>'not_started'),0) AS busy
          FROM multipart_attempts WHERE part_number=?`,
          partNumber,
        )
        .one();
      if (attempts.busy) throw new Error("part_busy_or_completed");
      if (
        attempts.count >= UPLOAD_LIMITS.attempts ||
        row.data_calls >= row.part_count * 3 ||
        row.data_bytes + expected > row.declared_bytes * 3
      )
        throw new Error("upload_data_budget_exceeded");
      const active = this.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM multipart_attempts WHERE state='in_flight'",
        )
        .one().count;
      if (active >= UPLOAD_LIMITS.parallel) throw new Error("upload_parallel_limit");
      const expiresAt = Math.min(
        now + UPLOAD_LIMITS.leaseMs,
        row.expires_at,
        row.last_progress_at + UPLOAD_LIMITS.idleMs,
      );
      this.storage.sql.exec(
        "INSERT INTO multipart_attempts VALUES(?,?,?,'in_flight',?,NULL,NULL)",
        attemptId,
        partNumber,
        expected,
        expiresAt,
      );
      this.storage.sql.exec(
        "UPDATE multipart_state SET state='uploading',data_calls=data_calls+1,data_bytes=data_bytes+? WHERE singleton=1",
        expected,
      );
      return { disposition: "dispatch", attemptId, partNumber, expectedBytes: expected, expiresAt };
    });
  }

  settle(epoch: number, attemptId: string, outcome: PartOutcome, now: number): boolean {
    timestamp(now);
    this.#required(epoch);
    this.advance(now);
    return this.storage.transactionSync(() => {
      const row = this.#required(epoch);
      const attempt = this.storage.sql
        .exec<AttemptRow>("SELECT * FROM multipart_attempts WHERE attempt_id=?", attemptId)
        .toArray()[0];
      if (!attempt) throw new Error("unknown_attempt");
      if (!accepting(row.state)) return false;
      if (
        outcome.kind === "completed" &&
        (outcome.bytes !== attempt.expected_bytes ||
          !outcome.etag ||
          outcome.etag.length > 1024 ||
          !HASH.test(outcome.sha256))
      )
        throw new Error("invalid_part_result");
      if (attempt.state !== "in_flight") {
        if (
          attempt.state === "completed" &&
          outcome.kind === "completed" &&
          attempt.etag === outcome.etag &&
          attempt.sha256 === outcome.sha256
        )
          return true;
        if (attempt.state === "not_started" && outcome.kind === "not_started") return true;
        throw new Error("attempt_result_conflict");
      }
      if (outcome.kind === "unknown") {
        this.#stop("aborting", "part_outcome_unknown");
        return false;
      }
      this.storage.sql.exec(
        "UPDATE multipart_attempts SET state=?,etag=?,sha256=? WHERE attempt_id=? AND state='in_flight'",
        outcome.kind,
        outcome.kind === "completed" ? outcome.etag : null,
        outcome.kind === "completed" ? outcome.sha256 : null,
        attemptId,
      );
      if (outcome.kind === "completed")
        this.storage.sql.exec(
          "UPDATE multipart_state SET last_progress_at=MAX(last_progress_at,?) WHERE singleton=1",
          now,
        );
      return true;
    });
  }

  beginComplete(epoch: number, now: number): void {
    this.#required(epoch);
    this.advance(now);
    this.storage.transactionSync(() => {
      const row = this.#required(epoch);
      if (row.state === "completing") return;
      if (!accepting(row.state)) throw new Error("upload_not_completable");
      const complete = this.storage.sql
        .exec<{ count: number; bytes: number }>(
          "SELECT COUNT(*) AS count,COALESCE(SUM(expected_bytes),0) AS bytes FROM multipart_attempts WHERE state='completed'",
        )
        .one();
      if (complete.count !== row.part_count || complete.bytes !== row.declared_bytes)
        throw new Error("upload_parts_incomplete");
      this.storage.sql.exec(
        "UPDATE multipart_state SET state='completing',control_calls=control_calls+1 WHERE singleton=1",
      );
    });
  }

  requestAbort(epoch: number, now: number): void {
    this.#required(epoch);
    this.advance(now);
    this.storage.transactionSync(() => {
      const row = this.#required(epoch);
      if (row.state === "completing") throw new Error("upload_complete_in_progress");
      if (!accepting(row.state)) return;
      this.#stop("aborting", "upload_aborted");
      this.storage.sql.exec(
        "UPDATE multipart_state SET control_calls=control_calls+1 WHERE singleton=1",
      );
    });
  }

  /** Only the authoritative ControlDO epoch may be supplied here. Never reinitialize old IDs. */
  invalidateEpoch(authoritativeEpoch: number): void {
    if (!Number.isSafeInteger(authoritativeEpoch) || authoritativeEpoch < 1)
      throw new Error("invalid_upload_epoch");
    this.storage.transactionSync(() => {
      const row = this.#row();
      if (!row || row.epoch === authoritativeEpoch) return;
      if (row.epoch > authoritativeEpoch) throw new Error("upload_epoch_conflict");
      this.#stop("failed", "stale_epoch");
    });
  }

  /** Cleanup is counted separately and remains available after the data budget is spent. */
  recordCleanupCall(): void {
    const row = this.#row();
    if (!row?.cleanup_pending) throw new Error("upload_cleanup_not_pending");
    this.storage.sql.exec(
      "UPDATE multipart_state SET cleanup_calls=cleanup_calls+1 WHERE singleton=1",
    );
  }

  status(now: number) {
    this.advance(now);
    const row = this.#row();
    if (!row) return null;
    const counts = this.storage.sql
      .exec<{ in_flight: number; completed: number }>(
        `SELECT COALESCE(SUM(state='in_flight'),0) AS in_flight,
        COALESCE(SUM(state='completed'),0) AS completed FROM multipart_attempts`,
      )
      .one();
    return {
      uploadId: row.upload_id,
      epoch: row.epoch,
      state: row.state,
      partCount: row.part_count,
      inFlight: counts.in_flight,
      completedParts: counts.completed,
      dataCalls: row.data_calls,
      dataBytes: row.data_bytes,
      controlCalls: row.control_calls,
      cleanupCalls: row.cleanup_calls,
      cleanupPending: row.cleanup_pending === 1,
      errorCode: row.error_code,
    };
  }

  /** At most 200 rows per read; never serialize the entire 10,000-part journal. */
  completedParts(after: number, limit = 200) {
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      after > UPLOAD_LIMITS.parts ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("invalid_part_page");
    return this.storage.sql
      .exec<AttemptRow>(
        "SELECT * FROM multipart_attempts WHERE state='completed' AND part_number>? ORDER BY part_number LIMIT ?",
        after,
        limit,
      )
      .toArray()
      .map((row) => ({
        partNumber: row.part_number,
        bytes: row.expected_bytes,
        etag: row.etag,
        sha256: row.sha256,
      }));
  }

  /** A failed D1 acknowledgement leaves these rows dirty for an idempotent retry. */
  mirrorSnapshot(now: number) {
    const status = this.status(now);
    if (!status) return null;
    const row = this.#required(status.epoch);
    const revision = this.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM multipart_mirror")
      .one().revision;
    const parts = this.storage.sql
      .exec<AttemptRow & { attempts: number }>(
        `SELECT a.*, (SELECT COUNT(*) FROM multipart_attempts b WHERE b.part_number=a.part_number) AS attempts
        FROM multipart_attempts a JOIN multipart_dirty d ON d.part_number=a.part_number
        WHERE a.rowid=(SELECT MAX(b.rowid) FROM multipart_attempts b WHERE b.part_number=a.part_number)
        ORDER BY a.part_number LIMIT 201`,
      )
      .toArray();
    if (parts.length > 200) throw new Error("upload_mirror_recovery_required");
    return { ...status, revision, lastProgressAt: row.last_progress_at, parts };
  }

  markMirrored(revision: number): void {
    const current = this.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM multipart_mirror")
      .one().revision;
    if (revision !== current) throw new Error("upload_mirror_conflict");
    this.storage.sql.exec("DELETE FROM multipart_dirty");
  }

  nextAlarmAt(): number | null {
    const row = this.#row();
    if (!row || !accepting(row.state)) return null;
    const lease = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(lease_expires_at) AS at FROM multipart_attempts WHERE state='in_flight'",
      )
      .one().at;
    return Math.min(row.expires_at, row.last_progress_at + UPLOAD_LIMITS.idleMs, lease ?? Infinity);
  }
}
