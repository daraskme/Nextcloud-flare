import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import {
  type EpochReason,
  epochNumber,
  parseEpochFloor,
  persistEpoch,
  recoverEpochFloor,
} from "./epochHistory";

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
  maintenance: true;
  gcPaused: true;
}

export interface QuiesceStatus extends ControlStatus {
  activeJobLease: boolean;
}

export class ControlDO extends DurableObject<Env> {
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
    const row = this.#row();
    if (row.phase !== "ready") throw new Error("control_not_ready");
    return { epoch: epochNumber(row.epoch), maintenance: true, gcPaused: true };
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
    const status = await this.status();
    if (status.epoch !== expectedEpoch || !status.maintenance || !status.gcPaused)
      throw new Error("quiesce_epoch_conflict");
    const clock = "strftime('%s','now')*1000";
    const statements = [
      {
        sql: `UPDATE control SET maintenance=1,gc_paused=1,updated_at=MAX(updated_at,${clock})
          WHERE singleton=1 AND epoch=?`,
        values: [expectedEpoch],
      },
      assertOneChange,
      { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
      {
        sql: `UPDATE operations SET state='failed',error_code='maintenance',
          updated_at=MAX(updated_at,${clock}) WHERE state='claimed'`,
      },
      assertExists(
        `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1
        AND NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
        AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')`,
        [expectedEpoch],
      ),
    ] as const;
    try {
      await atomicBatch(this.env.DB, statements);
    } catch (error) {
      // A lost batch acknowledgement is success only if every D1 postcondition is visible.
      const converged = await primary(this.env.DB)
        .prepare(`SELECT 1 FROM control
        WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1
          AND NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
          AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')`)
        .bind(expectedEpoch)
        .first<number>();
      if (converged === null) throw error;
    }
    const active = await primary(this.env.DB)
      .prepare(`SELECT 1 FROM job_leases
      WHERE expires_at>${clock} LIMIT 1`)
      .first<number>();
    const current = await this.status();
    if (current.epoch !== expectedEpoch) throw new Error("quiesce_epoch_conflict");
    return { ...current, activeJobLease: active !== null };
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
        sql: "UPDATE control SET epoch=?,maintenance=1,gc_paused=1,updated_at=? WHERE singleton=1 AND epoch<=?",
        values: [row.pending_epoch, Date.now(), row.pending_epoch],
      },
      assertOneChange,
      { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
      {
        sql: "UPDATE operations SET state='failed',error_code='stale_epoch',updated_at=? WHERE state='claimed' AND epoch<>?",
        values: [Date.now(), row.pending_epoch],
      },
    ]);
    const result = this.ctx.storage.sql.exec(
      `UPDATE control_state SET epoch=pending_epoch,phase='ready',
      pending_epoch=NULL,pending_at=NULL,pending_reason=NULL,pending_token=NULL
      WHERE singleton=1 AND phase='pending' AND pending_token=?`,
      row.pending_token,
    );
    if (result.rowsWritten !== 1) {
      const current = this.#row();
      if (current.phase !== "ready" || current.epoch !== row.pending_epoch)
        throw new Error("epoch_conflict");
    }
    // Recovery never resumes service. Admission/quiesce verification comes later in Foundation.
    return this.status();
  }
}
