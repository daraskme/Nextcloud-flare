import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { drainStoppedBlobGarbageCollection, type GcResult } from "../jobs/gc";
import { repairMultipartUploads } from "../jobs/multipartCleanup";
import {
  inspectMultipartInventory,
  type MultipartInventoryObservation,
  type MultipartInventoryQuery,
} from "../jobs/multipartInventory";
import {
  type MultipartInventoryRepairResult,
  repairUnidentifiedMultipartUploads,
} from "../jobs/multipartInventoryRepair";
import {
  drainStoppedOrphanGarbageCollection,
  type OrphanGcResult,
  type OrphanScanResult,
  scanOrphanObjects,
} from "../jobs/orphanInventory";
import { type BindingVerification, withVerifiedR2Inventory } from "../jobs/r2BindingVerification";
import { repairSingleUploads, type UploadCleanupResult } from "../jobs/uploadCleanup";
import { R2S3Inventory } from "../r2/s3Inventory";
import { ControlAdmission } from "./controlAdmission";
import {
  type EpochReason,
  epochNumber,
  parseEpochFloor,
  persistEpoch,
  recoverEpochFloor,
} from "./epochHistory";
import {
  failStaleRecoveryOutbox,
  inspectRecoveryFinalFence,
  inspectRecoveryPage,
  type RecoveryCursor,
  rebuildRecoverySearchFts,
  releaseStaleRecoveryReservations,
} from "./recoveryAudit";

export const CONTROL_NAME = "singleton";
interface ControlRow extends Record<string, SqlStorageValue> {
  phase: "uninitialized" | "pending" | "ready";
  epoch: number;
  pending_epoch: number | null;
  pending_at: number | null;
  pending_reason: EpochReason | null;
  pending_token: string | null;
}

export interface ControlStatus {
  epoch: number;
  maintenance: boolean;
  gcPaused: boolean;
}

export interface QuiesceStatus extends ControlStatus {
  activeJobLease: boolean;
}

interface AuditRow extends Record<string, SqlStorageValue> {
  epoch: number;
  token: string;
  stage:
    | "users"
    | "blobs"
    | "r2"
    | "outbox"
    | "shares"
    | "credentials"
    | "credential_sources"
    | "fts"
    | "fence"
    | "complete";
  after_id: string;
  pages: number;
}

export interface RecoveryAuditStatus {
  epoch: number;
  stage: AuditRow["stage"];
  afterId: string;
  pages: number;
  completed: boolean;
}

export class ControlDO extends DurableObject<Env> {
  readonly #admission: ControlAdmission;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Only local synchronous storage initialization. Never hold an input gate over R2/D1.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      phase TEXT NOT NULL CHECK(phase IN ('uninitialized','pending','ready')),
      epoch INTEGER NOT NULL CHECK(epoch>=0),
      pending_epoch INTEGER, pending_at INTEGER, pending_reason TEXT, pending_token TEXT
    )`);
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO control_state(singleton,phase,epoch) VALUES(1,'uninitialized',0)",
    );
    // A new diagnostic table avoids an in-place SQLite CHECK change on existing DOs.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS recovery_audit_v7(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      token TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('users','blobs','r2','outbox','shares','credentials','credential_sources','fts','fence','complete')),
      after_id TEXT NOT NULL,pages INTEGER NOT NULL CHECK(pages>=0)
    )`);
    this.#admission = new ControlAdmission(ctx.storage, env.DB, () => {
      const row = this.#row();
      if (row.phase !== "ready") throw new Error("control_not_ready");
      return epochNumber(row.epoch);
    });
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  #row(): ControlRow {
    if (this.ctx.id.toString() !== this.env.CONTROL.idFromName(CONTROL_NAME).toString()) {
      throw new Error("control_singleton_required");
    }
    return this.ctx.storage.sql
      .exec<ControlRow>("SELECT * FROM control_state WHERE singleton=1")
      .one();
  }

  async status(): Promise<ControlStatus> {
    return this.#admission.status();
  }

  /** Operator/maintenance RPC only. HTTP remains closed; no public recovery endpoint. */
  async recover(): Promise<ControlStatus> {
    const row = this.#row();
    if (row.phase === "ready") return this.status();
    if (row.phase === "pending") return this.#completePending(row);
    const d1Epoch = await primary(this.env.DB)
      .prepare("SELECT epoch FROM control WHERE singleton=1")
      .first<number>("epoch");
    if (d1Epoch === null) throw new Error("control_database_missing");
    const epoch = await recoverEpochFloor(
      this.env.BACKUPS,
      d1Epoch,
      parseEpochFloor(this.env.EPOCH_FLOOR),
    );
    const reason: EpochReason = epoch > 2 ? "storage_recovery" : "bootstrap";
    this.#reserve(epoch, reason, "uninitialized", 0);
    return this.#completePending(this.#row());
  }

  /** expectedEpoch prevents a retried request from silently issuing another epoch. */
  async bumpEpoch(expectedEpoch: number, reason: EpochReason): Promise<ControlStatus> {
    epochNumber(expectedEpoch);
    if (!["restore", "credential_rotation", "operator"].includes(reason))
      throw new Error("invalid_epoch_reason");
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch) throw new Error("epoch_conflict");
    const next = epochNumber(expectedEpoch + 1);
    this.#reserve(next, reason, "ready", expectedEpoch);
    return this.#completePending(this.#row());
  }

  /** Close D1 admission before inspecting in-flight work. Safe to repeat after an unknown response. */
  async quiesce(expectedEpoch: number): Promise<QuiesceStatus> {
    epochNumber(expectedEpoch);
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("quiesce_epoch_conflict");
    return this.#admission.close(expectedEpoch);
  }

  /** Internal operator RPCs; never exposed as unauthenticated HTTP endpoints. */
  async resumeAdmission(expectedEpoch: number): Promise<ControlStatus> {
    return this.#admission.resume(expectedEpoch);
  }

  async resumeGarbageCollection(expectedEpoch: number): Promise<ControlStatus> {
    return this.#admission.setGcPaused(expectedEpoch, false);
  }

  async pauseGarbageCollection(expectedEpoch: number): Promise<ControlStatus> {
    return this.#admission.setGcPaused(expectedEpoch, true);
  }

  async #maintenance<T>(expectedEpoch: number, action: () => Promise<T>): Promise<T> {
    const token = this.#admission.beginTask(expectedEpoch);
    try {
      await this.beginRecoveryAudit(expectedEpoch);
      return await action();
    } finally {
      try {
        if (this.#row().phase === "ready" && this.#row().epoch === expectedEpoch)
          await this.beginRecoveryAudit(expectedEpoch);
      } finally {
        this.#admission.finishTask(token);
      }
    }
  }

  #auditStatus(row: AuditRow): RecoveryAuditStatus {
    return {
      epoch: row.epoch,
      stage: row.stage,
      afterId: row.after_id,
      pages: row.pages,
      completed: row.stage === "complete",
    };
  }

  #auditRow(expectedEpoch: number): AuditRow {
    const row = this.ctx.storage.sql
      .exec<AuditRow>(
        "SELECT epoch,token,stage,after_id,pages FROM recovery_audit_v7 WHERE singleton=1",
      )
      .toArray()[0];
    if (!row || row.epoch !== expectedEpoch) throw new Error("recovery_audit_not_started");
    return row;
  }

  /** Explicit restart invalidates any in-flight page through the durable audit token. */
  async beginRecoveryAudit(expectedEpoch: number): Promise<RecoveryAuditStatus> {
    const stopped = await this.quiesce(expectedEpoch);
    if (stopped.activeJobLease) throw new Error("recovery_job_lease_active");
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("recovery_audit_epoch_conflict");
    this.#admission.assertClosed(expectedEpoch);
    this.ctx.storage.sql.exec(
      `INSERT INTO recovery_audit_v7(singleton,epoch,token,stage,after_id,pages)
      VALUES(1,?,?,'users','',0) ON CONFLICT(singleton) DO UPDATE SET
      epoch=excluded.epoch,token=excluded.token,stage='users',after_id='',pages=0`,
      expectedEpoch,
      crypto.randomUUID(),
    );
    return this.#auditStatus(this.#auditRow(expectedEpoch));
  }

  /** Rebuild restored external-content FTS, then invalidate every previous diagnostic page. */
  async rebuildRecoveryFts(expectedEpoch: number): Promise<RecoveryAuditStatus> {
    await this.#maintenance(expectedEpoch, () =>
      rebuildRecoverySearchFts(this.env.DB, expectedEpoch),
    );
    return this.#auditStatus(this.#auditRow(expectedEpoch));
  }

  /** Bounded stale reservation repair; upload cleanup remains a separate prerequisite. */
  async releaseStaleReservations(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ released: number; audit: RecoveryAuditStatus }> {
    const released = await this.#maintenance(expectedEpoch, () =>
      releaseStaleRecoveryReservations(this.env.DB, expectedEpoch, limit),
    );
    return { released, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Stop mutation claims and reconcile expired single uploads without reopening admission. */
  async repairExpiredUploads(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: UploadCleanupResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      repairSingleUploads(this.env.DB, this.env.BLOBS, expectedEpoch, {
        maxUploads: limit,
        maintenance: true,
      }),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Close known multipart handles under maintenance, then restart the diagnostic audit. */
  async repairStoppedMultipartUploads(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: UploadCleanupResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      repairMultipartUploads(this.env.DB, this.env.BLOBS, expectedEpoch, {
        maxUploads: limit,
        maintenance: true,
      }),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Finish already-claimed blob deletions while maintenance and GC pause remain set. */
  async drainBlobGarbageCollection(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: GcResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      drainStoppedBlobGarbageCollection(this.env.DB, this.env.BLOBS, expectedEpoch, {
        maxBlobs: limit,
      }),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Reconcile already-started orphan GC without shortening quarantine or admitting new work. */
  async drainOrphanGarbageCollection(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: OrphanGcResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      drainStoppedOrphanGarbageCollection(this.env.DB, this.env.BLOBS, expectedEpoch, { limit }),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Record one R2 inventory page under maintenance; no deletion or admission reopening. */
  async inventoryOrphanObjects(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ inventory: OrphanScanResult; audit: RecoveryAuditStatus }> {
    const inventory = await this.#maintenance(expectedEpoch, () =>
      scanOrphanObjects(this.env.DB, this.env.BLOBS, expectedEpoch, { limit, maintenance: true }),
    );
    return { inventory, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Read one S3 diagnostic page; never attach IDs, close handles, or release reservations. */
  async inspectIncompleteMultipart(
    expectedEpoch: number,
    query: MultipartInventoryQuery,
  ): Promise<{ observation: MultipartInventoryObservation; audit: RecoveryAuditStatus }> {
    const client = new R2S3Inventory(this.env);
    const observation = await this.#maintenance(expectedEpoch, () =>
      inspectMultipartInventory(this.env.DB, client, expectedEpoch, query),
    );
    return { observation, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Fresh binding witness only; the returned observation never authorizes later cleanup. */
  async verifyInventoryBinding(
    expectedEpoch: number,
  ): Promise<{ verification: BindingVerification; audit: RecoveryAuditStatus }> {
    const inventory = new R2S3Inventory(this.env);
    const verification = await this.#maintenance(expectedEpoch, () =>
      withVerifiedR2Inventory(
        this.env.DB,
        this.env.BLOBS,
        inventory,
        expectedEpoch,
        async (verified) => verified.observation,
      ),
    );
    return { verification, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Persist discovered handles and abort them through BLOBS, retaining unresolved reservations. */
  async repairUnidentifiedMultipartUploads(
    expectedEpoch: number,
    limit = 5,
  ): Promise<{ repair: MultipartInventoryRepairResult; audit: RecoveryAuditStatus }> {
    const inventory = new R2S3Inventory(this.env);
    const repair = await this.#maintenance(expectedEpoch, () =>
      repairUnidentifiedMultipartUploads(this.env.DB, this.env.BLOBS, inventory, expectedEpoch, {
        maxUploads: limit,
        maintenance: true,
      }),
    );
    return { repair, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Bounded old-epoch node notification repair; other event kinds require their own cleanup. */
  async failStaleOutbox(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ failed: number; audit: RecoveryAuditStatus }> {
    const failed = await this.#maintenance(expectedEpoch, () =>
      failStaleRecoveryOutbox(this.env.DB, expectedEpoch, limit),
    );
    return { failed, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Checks one page; a failed page leaves the durable cursor unchanged. */
  async nextRecoveryAuditPage(expectedEpoch: number, limit = 10): Promise<RecoveryAuditStatus> {
    epochNumber(expectedEpoch);
    const status = await this.status();
    if (status.epoch !== expectedEpoch) throw new Error("recovery_audit_epoch_conflict");
    this.#admission.assertClosed(expectedEpoch);
    const row = this.#auditRow(expectedEpoch);
    if (row.stage === "complete") {
      try {
        await inspectRecoveryFinalFence(this.env.DB, expectedEpoch);
      } catch (error) {
        // A completed diagnostic is not durable proof that D1 stayed quiescent.
        // Restart all pages after a failed fence so earlier observations are refreshed.
        const reset = this.ctx.storage.sql.exec(
          `UPDATE recovery_audit_v7 SET token=?,stage='users',after_id='',pages=0
          WHERE singleton=1 AND epoch=? AND token=? AND stage='complete'`,
          crypto.randomUUID(),
          expectedEpoch,
          row.token,
        );
        if (reset.rowsWritten !== 1) throw new Error("recovery_audit_conflict");
        throw error;
      }
      this.#admission.assertClosed(expectedEpoch);
      const current = this.#auditRow(expectedEpoch);
      if (current.token !== row.token) throw new Error("recovery_audit_conflict");
      return this.#auditStatus(current);
    }
    const cursor: RecoveryCursor = { stage: row.stage, afterId: row.after_id };
    const page = await inspectRecoveryPage(
      this.env.DB,
      this.env.BLOBS,
      expectedEpoch,
      cursor,
      limit,
    );
    const current = this.#row();
    if (current.phase !== "ready" || current.epoch !== expectedEpoch)
      throw new Error("recovery_audit_epoch_conflict");
    this.#admission.assertClosed(expectedEpoch);
    const next = page.next;
    const updated = this.ctx.storage.sql.exec(
      `UPDATE recovery_audit_v7
      SET stage=?,after_id=?,pages=pages+1
      WHERE singleton=1 AND epoch=? AND token=? AND stage=? AND after_id=? AND pages=?`,
      next?.stage ?? "complete",
      next?.afterId ?? "",
      expectedEpoch,
      row.token,
      row.stage,
      row.after_id,
      row.pages,
    );
    if (updated.rowsWritten !== 1) throw new Error("recovery_audit_conflict");
    return this.#auditStatus(this.#auditRow(expectedEpoch));
  }

  #reserve(epoch: number, reason: EpochReason, phase: ControlRow["phase"], expected: number): void {
    const result = this.ctx.storage.sql.exec(
      `UPDATE control_state SET phase='pending',pending_epoch=?,pending_at=?,
      pending_reason=?,pending_token=? WHERE singleton=1 AND phase=? AND epoch=?`,
      epoch,
      Date.now(),
      reason,
      crypto.randomUUID(),
      phase,
      expected,
    );
    if (result.rowsWritten !== 1) throw new Error("epoch_conflict");
    this.ctx.storage.sql.exec("DELETE FROM recovery_audit_v7");
  }

  async #completePending(row: ControlRow): Promise<ControlStatus> {
    if (
      row.pending_epoch === null ||
      row.pending_at === null ||
      row.pending_reason === null ||
      row.pending_token === null
    ) {
      throw new Error("invalid_pending_epoch");
    }
    // A lost response leaves this durable pending row. recover() rechecks the immutable R2 record.
    await persistEpoch(this.env.BACKUPS, {
      epoch: row.pending_epoch,
      at: row.pending_at,
      reason: row.pending_reason,
    });
    await atomicBatch(this.env.DB, [
      {
        sql: `UPDATE control SET epoch=?,maintenance=1,gc_paused=1,updated_at=?,admission_revision=0,admission_token=?
          WHERE singleton=1 AND (epoch<? OR (epoch=? AND admission_revision=0 AND maintenance=1 AND gc_paused=1
            AND (admission_token IS NULL OR admission_token=?)))`,
        values: [
          row.pending_epoch,
          Date.now(),
          row.pending_token,
          row.pending_epoch,
          row.pending_epoch,
          row.pending_token,
        ],
      },
      assertOneChange,
      { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
      {
        sql: "UPDATE operations SET state='failed',error_code='stale_epoch',updated_at=? WHERE state='claimed' AND epoch<>?",
        values: [Date.now(), row.pending_epoch],
      },
    ]);
    this.ctx.storage.transactionSync(() => {
      const result = this.ctx.storage.sql.exec(
        `UPDATE control_state SET epoch=pending_epoch,phase='ready',
        pending_epoch=NULL,pending_at=NULL,pending_reason=NULL,pending_token=NULL
        WHERE singleton=1 AND phase='pending' AND pending_token=?`,
        row.pending_token,
      );
      if (result.rowsWritten === 1) {
        this.#admission.resetEpoch(row.pending_epoch!, row.pending_token!);
      } else {
        const current = this.#row();
        if (current.phase !== "ready" || current.epoch !== row.pending_epoch)
          throw new Error("epoch_conflict");
      }
    });
    // Epoch recovery always closes admission; reopening requires a new complete audit.
    return this.status();
  }
}
