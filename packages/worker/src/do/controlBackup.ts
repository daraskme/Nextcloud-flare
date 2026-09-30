import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { BackupInventoryCursor } from "../../../shared/src/backupRetention";
import { inspectBackupInventory } from "../backup/inventory";
import { pruneBackupGeneration } from "../backup/prune";
import { verifyPublicationPart } from "../backup/publication";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { ControlBackupSweep, initializeBackupSweep } from "./controlBackupSweep";
import { epochNumber } from "./epochHistory";

export interface BackupAdmissionSnapshot {
  epoch: number;
  revision: number;
  phase: "open" | "closed";
  token: string | null;
  gc_paused: number;
  operator_paused: number;
  audit_token: string | null;
}
interface BackupRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  phase: "preparing" | "frozen" | "releasing" | "released";
  token: string;
  release_token: string;
  cancelled: number;
  prior_json: string;
  created_at: number;
  watermark: string | null;
}
export interface BackupBarrierStatus {
  id: string;
  epoch: number;
  state: BackupRow["phase"];
  watermark: string | null;
}
interface PublicationRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  hash: string;
  cursor: number;
  total: number;
  phase: "verifying" | "verified" | "completing" | "completed";
}
export interface BackupCompletionStatus {
  id: string;
  epoch: number;
  state: "verifying" | "completed";
  manifestSha256: string;
  partsVerified: number;
  partsTotal: number;
}
interface DailyRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  scheduled_at: number;
}
export type BackupDailyPlan = {
  id: string;
  epoch: number;
  scheduledAt: number;
  observedAt: number;
} & (
  | { state: "run" }
  | { state: "completed"; createdAt: number; completedAt: number; manifestSha256: string }
);
const clock = "strftime('%s','now')*1000";
const drained = `NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
  AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')`;

export function initializeBackupState(sql: SqlStorage): void {
  initializeBackupSweep(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('preparing','frozen','releasing','released')),
    token TEXT NOT NULL,release_token TEXT NOT NULL,cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)),
    prior_json TEXT NOT NULL,created_at INTEGER NOT NULL,watermark TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup_publication(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, epoch INTEGER NOT NULL,
    hash TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor>=0), total INTEGER NOT NULL CHECK(total>=0),
    phase TEXT NOT NULL CHECK(phase IN ('verifying','verified','completing','completed'))
  )`);
  // The server owns the next daily identity before an exporter attempts begin.
  // One row bounds storage; completed generations retain their immutable D1 receipts.
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup_daily(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,
    epoch INTEGER NOT NULL,scheduled_at INTEGER NOT NULL
  )`);
}
export function backupActive(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM control_backup WHERE phase<>'released'").toArray().length > 0;
}
export function assertNoBackup(sql: SqlStorage): void {
  if (backupActive(sql)) throw new Error("backup_active");
}

/** Internal RPC only. Exporters retain this barrier through every table until a durable snapshot exists. */
export class ControlBackup {
  #completionInFlight = false;
  #pruneInFlight = false;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly currentEpoch: () => number,
    private readonly capture: () => BackupAdmissionSnapshot,
    private readonly restore: (snapshot: BackupAdmissionSnapshot, token: string) => void,
    private readonly backups: R2Bucket,
  ) {}

  #row(): BackupRow | undefined {
    return this.storage.sql
      .exec<BackupRow>("SELECT * FROM control_backup WHERE singleton=1")
      .toArray()[0];
  }
  #publication(): PublicationRow | undefined {
    return this.storage.sql
      .exec<PublicationRow>("SELECT * FROM control_backup_publication WHERE singleton=1")
      .toArray()[0];
  }
  #completionStatus(row: PublicationRow): BackupCompletionStatus {
    return {
      id: row.id,
      epoch: row.epoch,
      state: row.phase === "completed" ? "completed" : "verifying",
      manifestSha256: row.hash,
      partsVerified: row.cursor,
      partsTotal: row.total,
    };
  }

  inventory(epoch: number, cursor?: BackupInventoryCursor) {
    return inspectBackupInventory(
      this.db,
      epoch,
      () => {
        const row = this.#row();
        return {
          epoch: this.currentEpoch(),
          token: row?.token ?? null,
          phase: row?.phase ?? null,
          active:
            row && row.phase !== "released"
              ? { id: row.id, epoch: row.epoch, phase: row.phase, createdAt: row.created_at }
              : null,
        };
      },
      cursor,
    );
  }

  async prune(epoch: number, id: string) {
    if (this.#pruneInFlight) throw new Error("backup_prune_busy");
    this.#pruneInFlight = true;
    try {
      return await pruneBackupGeneration({
        db: this.db,
        bucket: this.backups,
        epoch,
        id,
        authority: () => {
          const row = this.#row();
          return {
            epoch: this.currentEpoch(),
            token: row?.token ?? null,
            phase: row?.phase ?? null,
          };
        },
      });
    } finally {
      this.#pruneInFlight = false;
    }
  }

  async sweep(epoch: number, round?: string) {
    if (this.#pruneInFlight) throw new Error("backup_prune_busy");
    this.#pruneInFlight = true;
    try {
      const sweep = new ControlBackupSweep(this.storage.sql, this.db, this.backups, () => {
        const row = this.#row();
        return { epoch: this.currentEpoch(), token: row?.token ?? null, phase: row?.phase ?? null };
      });
      return round === undefined ? await sweep.plan(epoch) : await sweep.step(epoch, round);
    } finally {
      this.#pruneInFlight = false;
    }
  }

  /** Persist identity before returning it, including across lost ACKs and UTC midnight. */
  async daily(epoch: number, replaceCompletedId?: string): Promise<BackupDailyPlan> {
    epochNumber(epoch);
    if (replaceCompletedId !== undefined) backupManifestKey(replaceCompletedId);
    if (this.currentEpoch() !== epoch) throw new Error("invalid_backup_request");
    const previous = this.storage.sql
      .exec<DailyRow>("SELECT * FROM control_backup_daily WHERE singleton=1")
      .toArray()[0];
    const active = this.#row();
    const result = await primary(this.db).batch([
      primary(this.db).prepare(
        "SELECT epoch,backup_frozen,backup_token FROM control WHERE singleton=1",
      ),
      primary(this.db)
        .prepare(`SELECT id,epoch,state,created_at AS createdAt,completed_at AS completedAt,
        released_at AS releasedAt,manifest_key AS manifestKey,manifest_sha256 AS manifestSha256
        FROM backup_runs WHERE id=?`)
        .bind(previous?.id ?? ""),
    ]);
    const current = this.storage.sql
      .exec<DailyRow>("SELECT * FROM control_backup_daily WHERE singleton=1")
      .toArray()[0];
    if (
      this.currentEpoch() !== epoch ||
      current?.id !== previous?.id ||
      this.#row()?.token !== active?.token ||
      this.#row()?.phase !== active?.phase
    )
      throw new Error("backup_conflict");
    const mirror = result[0]?.results[0] as
      | { epoch: number; backup_frozen: number; backup_token: string | null }
      | undefined;
    if (mirror?.epoch !== epoch) throw new Error("backup_mirror_conflict");
    const observedAt = Date.now();
    if (previous && observedAt < previous.scheduled_at) throw new Error("backup_clock_conflict");
    const plan = (row: DailyRow): BackupDailyPlan => ({
      id: row.id,
      epoch: row.epoch,
      scheduledAt: row.scheduled_at,
      observedAt,
      state: "run",
    });
    if (active && active.phase !== "released") {
      if (previous?.id !== active.id || previous.epoch !== epoch || active.epoch !== epoch)
        throw new Error("backup_active");
      // Preparing can precede the D1 row. Completing can outlive the D1 receipt.
      return plan(previous);
    }
    if (mirror.backup_frozen !== 0 || mirror.backup_token !== null)
      throw new Error("backup_mirror_conflict");
    const receipt = result[1]?.results[0] as
      | {
          id: string;
          epoch: number;
          state: string;
          createdAt: number;
          completedAt: number | null;
          releasedAt: number | null;
          manifestKey: string | null;
          manifestSha256: string | null;
        }
      | undefined;
    if (previous && receipt) {
      if (receipt.epoch !== previous.epoch) throw new Error("backup_generation_conflict");
      if (receipt.state === "completed") {
        if (
          !Number.isSafeInteger(receipt.createdAt) ||
          receipt.createdAt < 0 ||
          !Number.isSafeInteger(receipt.completedAt) ||
          receipt.completedAt! < receipt.createdAt ||
          !Number.isSafeInteger(receipt.releasedAt) ||
          receipt.releasedAt! < receipt.createdAt ||
          receipt.manifestKey !== backupManifestKey(previous.id) ||
          typeof receipt.manifestSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(receipt.manifestSha256)
        )
          throw new Error("backup_invalid_receipt");
        if (observedAt < receipt.createdAt || observedAt < receipt.completedAt!)
          throw new Error("backup_clock_conflict");
        if (
          previous.epoch === epoch &&
          previous.id !== replaceCompletedId &&
          Math.floor(observedAt / 86400000) === Math.floor(receipt.createdAt / 86400000)
        )
          return {
            ...plan(previous),
            state: "completed",
            createdAt: receipt.createdAt,
            completedAt: receipt.completedAt!,
            manifestSha256: receipt.manifestSha256,
          };
      } else if (receipt.state !== "failed" || receipt.releasedAt === null) {
        // A pending receipt without its active DO authority needs explicit recovery.
        throw new Error("backup_daily_recovery_required");
      }
    } else if (previous?.epoch === epoch) {
      if (active?.id === previous.id) throw new Error("backup_receipt_missing");
      return plan(previous);
    }
    // An older epoch with no D1 receipt/active intent cannot start later: begin
    // enforces the current epoch. A terminal failed generation may be retried with
    // a new identity, but the planner never cancels a live/unknown generation.
    const next = { id: crypto.randomUUID(), epoch, scheduled_at: observedAt };
    this.storage.sql.exec(
      `INSERT INTO control_backup_daily VALUES(1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,scheduled_at=excluded.scheduled_at`,
      next.id,
      epoch,
      observedAt,
    );
    return plan(next);
  }

  /** Only a trusted exporter may attest the manifest hash after full offline SQL verification. */
  async complete(epoch: number, id: string, hash: string): Promise<BackupCompletionStatus> {
    if (this.#completionInFlight) throw new Error("backup_verification_busy");
    this.#completionInFlight = true;
    try {
      return await this.#complete(epoch, id, hash);
    } finally {
      this.#completionInFlight = false;
    }
  }

  async #complete(epoch: number, id: string, hash: string): Promise<BackupCompletionStatus> {
    this.#identity(epoch, id);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("backup_invalid_manifest_hash");
    const row = this.#row();
    if (!row || row.id !== id || row.epoch !== epoch) throw new Error("backup_conflict");
    let publication = this.#publication();
    if (publication?.id === id && (publication.hash !== hash || publication.epoch !== epoch))
      throw new Error("backup_publication_conflict");
    if (row.phase === "released") {
      if (publication?.id !== id || publication.phase !== "completed")
        throw new Error("backup_not_frozen");
      const receipt = await primary(this.db)
        .prepare(
          "SELECT 1 FROM backup_runs WHERE id=? AND epoch=? AND state='completed' AND manifest_key=? AND manifest_sha256=? AND released_at IS NOT NULL AND completed_at IS NOT NULL",
        )
        .bind(id, epoch, backupManifestKey(id), hash)
        .first();
      this.#current(row);
      if (!receipt) throw new Error("backup_receipt_missing");
      return this.#completionStatus(publication);
    }
    if (row.phase === "releasing") {
      if (publication?.id !== id || publication.phase !== "completing")
        throw new Error("backup_conflict");
      await this.release(epoch, id, false, hash);
      return this.#completionStatus(this.#publication()!);
    }
    if (row.phase !== "frozen" || !(await this.#prepared(row, true)))
      throw new Error("backup_not_frozen");
    this.#current(row);
    // The D1 read yielded: another verifier may already have pinned this generation's hash.
    publication = this.#publication();
    if (publication?.id === id && (publication.hash !== hash || publication.epoch !== epoch))
      throw new Error("backup_publication_conflict");
    if (!publication || publication.id !== id) {
      this.storage.sql.exec(
        `INSERT INTO control_backup_publication VALUES(1,?,?,?,0,0,'verifying')
        ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,hash=excluded.hash,cursor=0,total=0,phase='verifying'`,
        id,
        epoch,
        hash,
      );
      publication = this.#publication()!;
    }
    if (publication.phase === "verifying") {
      const page = await verifyPublicationPart(
        this.backups,
        {
          id,
          epoch,
          token: row.token,
          createdAt: row.created_at,
          watermark: row.watermark,
        },
        hash,
        publication.cursor,
      );
      this.#current(row);
      if (!(await this.#prepared(row, true))) throw new Error("backup_not_frozen");
      this.#current(row);
      this.storage.sql.exec(
        `UPDATE control_backup_publication SET cursor=?,total=?,phase=?
        WHERE singleton=1 AND id=? AND epoch=? AND hash=? AND cursor=? AND phase='verifying'`,
        page.next,
        page.parts,
        page.next === page.parts ? "verified" : "verifying",
        id,
        epoch,
        hash,
        publication.cursor,
      );
      publication = this.#publication()!;
      if (publication.id !== id || publication.hash !== hash)
        throw new Error("backup_publication_conflict");
    }
    if (publication.phase === "verified") {
      await this.release(epoch, id, false, hash);
      publication = this.#publication()!;
    }
    return this.#completionStatus(publication);
  }
  #current(row: BackupRow): void {
    const current = this.#row();
    if (
      this.currentEpoch() !== row.epoch ||
      current?.token !== row.token ||
      current.phase !== row.phase
    )
      throw new Error("backup_conflict");
  }
  #status(row: BackupRow): BackupBarrierStatus {
    return { id: row.id, epoch: row.epoch, state: row.phase, watermark: row.watermark };
  }
  #identity(epoch: number, id: string): void {
    epochNumber(epoch);
    if (
      this.currentEpoch() !== epoch ||
      typeof id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    )
      throw new Error("invalid_backup_request");
  }
  async #prepared(row: BackupRow, frozen: boolean): Promise<{ watermark: string | null } | null> {
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    return primary(this.db)
      .prepare(`SELECT b.watermark FROM control c JOIN backup_runs b ON b.barrier_token=c.backup_token
      WHERE c.singleton=1 AND c.epoch=? AND c.backup_token=? AND c.backup_frozen=?
      AND c.admission_revision=? AND c.admission_token=? AND c.maintenance=1 AND c.gc_paused=1
      AND c.gc_operator_paused=1 AND c.gc_hold_token IS NULL AND c.gc_hold_operation IS NULL AND c.gc_hold_expires_at IS NULL
      AND b.id=? AND b.epoch=c.epoch AND b.created_at=? AND b.released_at IS NULL AND b.state=?
      AND ${drained} ${frozen ? "AND b.watermark IS c.backup_barrier_op AND b.watermark IS c.backup_last_op" : ""}`)
      .bind(
        row.epoch,
        row.token,
        Number(frozen),
        prior.revision + 1,
        row.token,
        row.id,
        row.created_at,
        frozen ? "exporting" : "pending",
      )
      .first<{ watermark: string | null }>();
  }
  async begin(epoch: number, id: string): Promise<BackupBarrierStatus> {
    this.#identity(epoch, id);
    let row = this.#row();
    if (row?.id === id) {
      if (row.epoch !== epoch || row.phase === "releasing") throw new Error("backup_conflict");
      if (row.phase === "released") return this.#status(row);
    } else {
      if (row && row.phase !== "released") throw new Error("backup_active");
      const history = await primary(this.db)
        .prepare("SELECT epoch,watermark,released_at FROM backup_runs WHERE id=?")
        .bind(id)
        .first<{ epoch: number; watermark: string | null; released_at: number | null }>();
      if (this.#row()?.token !== row?.token || this.#row()?.phase !== row?.phase)
        throw new Error("backup_conflict");
      this.#identity(epoch, id);
      if (history) {
        if (history.epoch !== epoch || history.released_at === null)
          throw new Error("backup_history_conflict");
        return { id, epoch, state: "released", watermark: history.watermark };
      }
      const prior = this.capture();
      epochNumber(prior.revision + 2);
      this.storage.sql.exec(
        `INSERT INTO control_backup VALUES(1,?,?,'preparing',?,?,0,?,?,NULL)
        ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,phase=excluded.phase,
        token=excluded.token,release_token=excluded.release_token,cancelled=0,prior_json=excluded.prior_json,
        created_at=excluded.created_at,watermark=NULL`,
        id,
        epoch,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify(prior),
        Date.now(),
      );
      row = this.#row()!;
    }
    const frozen = await this.#prepared(row, true);
    this.#current(row);
    if (frozen) return this.#finishFreeze(row, frozen.watermark);
    if (row.phase !== "preparing") throw new Error("backup_mirror_conflict");
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    if (!(await this.#prepared(row, false))) {
      this.#current(row);
      try {
        await atomicBatch(this.db, [
          assertExists(
            `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND backup_token IS NULL AND backup_frozen=0
            AND admission_revision=? AND admission_token IS ? AND maintenance=? AND gc_paused=? AND gc_operator_paused=?
            AND gc_hold_token IS NULL AND gc_hold_operation IS NULL AND gc_hold_expires_at IS NULL`,
            [
              epoch,
              prior.revision,
              prior.token,
              Number(prior.phase === "closed"),
              prior.gc_paused,
              prior.operator_paused,
            ],
          ),
          {
            sql: "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,?,'pending',?,?)",
            values: [id, epoch, row.created_at, row.token],
          },
          {
            sql: `UPDATE control SET backup_token=?,maintenance=1,gc_paused=1,gc_operator_paused=1,
            admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock}) WHERE singleton=1`,
            values: [row.token, prior.revision + 1, row.token],
          },
          assertOneChange,
          { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
          {
            sql: `UPDATE operations SET state='failed',error_code='backup',updated_at=MAX(updated_at,${clock}) WHERE state='claimed'`,
          },
          assertExists(`SELECT 1 FROM control WHERE singleton=1 AND ${drained}`),
        ]);
      } catch (error) {
        if (!(await this.#prepared(row, false))) throw error;
      }
    }
    this.#current(row);
    try {
      await atomicBatch(this.db, [
        assertExists(
          `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND backup_token=? AND backup_frozen=0
          AND admission_revision=? AND admission_token=? AND maintenance=1 AND gc_paused=1 AND ${drained}
          AND NOT EXISTS(SELECT 1 FROM job_leases WHERE expires_at>${clock})`,
          [epoch, row.token, prior.revision + 1, row.token],
        ),
        {
          sql: `UPDATE backup_runs SET state='exporting',watermark=(SELECT backup_last_op FROM control WHERE singleton=1)
          WHERE id=? AND barrier_token=? AND state='pending' AND released_at IS NULL`,
          values: [id, row.token],
        },
        assertOneChange,
        {
          sql: "UPDATE control SET backup_barrier_op=(SELECT watermark FROM backup_runs WHERE id=?) WHERE singleton=1",
          values: [id],
        },
        { sql: "UPDATE control SET backup_frozen=1 WHERE singleton=1" },
        assertOneChange,
      ]);
    } catch (error) {
      if (!(await this.#prepared(row, true))) throw error;
    }
    const receipt = await this.#prepared(row, true);
    if (!receipt) throw new Error("backup_mirror_conflict");
    return this.#finishFreeze(row, receipt.watermark);
  }
  #finishFreeze(row: BackupRow, watermark: string | null): BackupBarrierStatus {
    this.#current(row);
    this.storage.sql.exec(
      "UPDATE control_backup SET phase='frozen',watermark=? WHERE singleton=1",
      watermark,
    );
    return this.#status(this.#row()!);
  }

  /** Release is explicit, never lease-driven. It does not claim that a backup manifest was published. */
  async release(
    epoch: number,
    id: string,
    cancelled = false,
    completionHash?: string,
  ): Promise<BackupBarrierStatus> {
    this.#identity(epoch, id);
    let row = this.#row();
    if (!row || row.id !== id || row.epoch !== epoch) throw new Error("backup_conflict");
    const publication = this.#publication();
    if (
      completionHash !== undefined &&
      (cancelled ||
        publication?.id !== id ||
        publication.hash !== completionHash ||
        !["verified", "completing", "completed"].includes(publication.phase) ||
        publication.cursor !== publication.total ||
        publication.total < 1)
    )
      throw new Error("backup_publication_conflict");
    if (
      completionHash === undefined &&
      publication?.id === id &&
      publication.phase === "completing"
    )
      throw new Error("backup_completion_in_progress");
    if (row.phase === "released") return this.#status(row);
    if (row.phase === "releasing") {
      if (row.cancelled !== Number(cancelled)) throw new Error("backup_conflict");
    } else {
      if (row.phase !== "frozen" && !cancelled) throw new Error("backup_not_frozen");
      this.storage.transactionSync(() => {
        this.storage.sql.exec(
          "UPDATE control_backup SET phase='releasing',cancelled=? WHERE singleton=1",
          Number(cancelled),
        );
        if (completionHash !== undefined)
          this.storage.sql.exec(
            "UPDATE control_backup_publication SET phase='completing' WHERE singleton=1",
          );
      });
      row = this.#row()!;
    }
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    if (!(await this.#released(row, prior, completionHash))) {
      this.#current(row);
      try {
        await atomicBatch(this.db, [
          // Frozen control permits only this single-column thaw. The rest is in the same atomic batch.
          {
            sql: "UPDATE control SET backup_frozen=0 WHERE singleton=1 AND epoch=? AND backup_token=? AND backup_frozen=1",
            values: [epoch, row.token],
          },
          {
            sql: `UPDATE control SET backup_token=NULL,maintenance=?,gc_paused=?,gc_operator_paused=?,
            admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock}) WHERE singleton=1 AND epoch=? AND backup_frozen=0
            AND ((backup_token=? AND admission_revision=? AND admission_token=?)
              OR (?=1 AND backup_token IS NULL AND admission_revision=? AND admission_token IS ?))`,
            values: [
              Number(prior.phase === "closed"),
              prior.gc_paused,
              prior.operator_paused,
              prior.revision + 2,
              row.release_token,
              epoch,
              row.token,
              prior.revision + 1,
              row.token,
              row.cancelled,
              prior.revision,
              prior.token,
            ],
          },
          assertOneChange,
          ...(cancelled
            ? [
                {
                  sql: `INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token)
            SELECT ?,?,'pending',?,? WHERE NOT EXISTS(SELECT 1 FROM backup_runs WHERE id=?)`,
                  values: [id, epoch, row.created_at, row.token, id],
                },
              ]
            : []),
          {
            sql: `UPDATE backup_runs SET released_at=MAX(created_at,${clock}),state=CASE WHEN ?=1 THEN 'failed' WHEN ? IS NOT NULL THEN 'completed' ELSE state END,
            completed_at=CASE WHEN ?=1 OR ? IS NOT NULL THEN MAX(created_at,${clock}) ELSE completed_at END,
            manifest_key=CASE WHEN ? IS NOT NULL THEN ? ELSE manifest_key END,
            manifest_sha256=CASE WHEN ? IS NOT NULL THEN ? ELSE manifest_sha256 END
            WHERE id=? AND epoch=? AND barrier_token=? AND released_at IS NULL AND state IN ('pending','exporting')`,
            values: [
              row.cancelled,
              completionHash ?? null,
              row.cancelled,
              completionHash ?? null,
              completionHash ?? null,
              backupManifestKey(id),
              completionHash ?? null,
              completionHash ?? null,
              id,
              epoch,
              row.token,
            ],
          },
          assertOneChange,
        ]);
      } catch (error) {
        if (!(await this.#released(row, prior, completionHash))) throw error;
      }
    }
    this.#current(row);
    this.storage.transactionSync(() => {
      this.restore(prior, row.release_token);
      this.storage.sql.exec("UPDATE control_backup SET phase='released' WHERE singleton=1");
      if (completionHash !== undefined)
        this.storage.sql.exec(
          "UPDATE control_backup_publication SET phase='completed' WHERE singleton=1",
        );
    });
    return this.#status(this.#row()!);
  }
  async #released(
    row: BackupRow,
    prior: BackupAdmissionSnapshot,
    completionHash?: string,
  ): Promise<boolean> {
    return (
      (await primary(this.db)
        .prepare(`SELECT 1 FROM control c JOIN backup_runs b ON b.id=?
      WHERE c.singleton=1 AND c.epoch=? AND c.backup_token IS NULL AND c.backup_frozen=0
      AND c.admission_revision=? AND c.admission_token=? AND c.maintenance=? AND c.gc_paused=? AND c.gc_operator_paused=?
      AND c.gc_hold_token IS NULL AND c.gc_hold_operation IS NULL AND c.gc_hold_expires_at IS NULL
      AND b.epoch=c.epoch AND b.barrier_token=? AND b.created_at=? AND b.released_at IS NOT NULL AND b.state=?
      AND (? IS NULL OR (b.manifest_key=? AND b.manifest_sha256=? AND b.completed_at IS NOT NULL))`)
        .bind(
          row.id,
          row.epoch,
          prior.revision + 2,
          row.release_token,
          Number(prior.phase === "closed"),
          prior.gc_paused,
          prior.operator_paused,
          row.token,
          row.created_at,
          row.cancelled ? "failed" : completionHash ? "completed" : "exporting",
          completionHash ?? null,
          backupManifestKey(row.id),
          completionHash ?? null,
        )
        .first()) !== null
    );
  }
}
