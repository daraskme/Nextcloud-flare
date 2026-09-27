import { type RestoreFreezeTargets, restoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { ControlAdmission } from "./controlAdmission";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";
import { RECOVERY_FINAL_QUERY } from "./recoveryAudit";

interface FreezeRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  token: string;
  phase: "freezing" | "frozen" | "cancelling" | "cancelled";
  challenge_json: string;
  proof_json: string;
  expires_at: number;
  started_at: number;
  frozen_at: number | null;
  cancel_token: string | null;
  cancel_revision: number | null;
}
export interface RestoreFreezeInput {
  challenge: RestoreD1Challenge;
  blobsAttempt: string;
  backupsAttempt: string;
}
interface Proof {
  expiresAt: number;
  blobs: { source: RestoreFreezeTargets["blobs"]; attemptId: string };
  backups: { source: RestoreFreezeTargets["backups"]; attemptId: string };
}
interface Mirror {
  epoch: number;
  admission_revision: number;
  admission_token: string;
  maintenance: number;
  gc_paused: number;
  backup_frozen: number;
  backup_token: string | null;
  restore_freeze_token: string | null;
}
const mirrorQuery = `SELECT epoch,admission_revision,admission_token,maintenance,gc_paused,
  backup_frozen,backup_token,restore_freeze_token FROM control WHERE singleton=1`;
const clock = "strftime('%s','now')*1000";

/** A D1 write barrier, not proof that every external R2 operation has finished or an overwrite grant. */
export class ControlRestoreFreeze {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly admission: ControlAdmission,
    private readonly localReady: (epoch: number) => void,
    private readonly proof: (epoch: number, id: string, input: RestoreFreezeInput) => Proof,
  ) {}

  #row(epoch: number, id: string): FreezeRow | undefined {
    this.restore.inspect(epoch, id);
    return this.storage.sql
      .exec<FreezeRow>(
        "SELECT * FROM control_database_restore_freeze WHERE id=? AND epoch=?",
        id,
        epoch,
      )
      .toArray()[0];
  }

  #status(row: FreezeRow) {
    const c = JSON.parse(row.challenge_json) as RestoreD1Challenge;
    const p = JSON.parse(row.proof_json) as Proof;
    return {
      ...this.restore.inspect(row.epoch, row.id),
      targets: restoreFreezeTargets({
        target: c.target,
        blobs: p.blobs.source,
        backups: p.backups.source,
      }),
      validator: "d1-write-freeze-v1" as const,
      startedAt: row.started_at,
      frozenAt: row.frozen_at,
    };
  }

  async #run<T>(epoch: number, id: string, action: (current: () => void) => Promise<T>) {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const current = () => {
      if (!active || Date.now() < started || Date.now() >= started + 25000)
        throw new Error("database_restore_freeze_timeout");
      this.localReady(epoch);
      const row = this.#row(epoch, id);
      if (row && Date.now() < Math.max(row.started_at, row.frozen_at ?? 0))
        throw new Error("database_restore_freeze_clock_conflict");
    };
    try {
      current();
      return await Promise.race([
        action(current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_freeze_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  #same(row: FreezeRow, phase: FreezeRow["phase"]) {
    const found = this.#row(row.epoch, row.id);
    if (
      !found ||
      found.token !== row.token ||
      found.phase !== phase ||
      found.challenge_json !== row.challenge_json ||
      found.proof_json !== row.proof_json ||
      found.cancel_token !== row.cancel_token ||
      found.cancel_revision !== row.cancel_revision
    )
      throw new Error("database_restore_freeze_conflict");
    return found;
  }

  #matches(m: Mirror | null, row: FreezeRow, cancelled = false) {
    const c = JSON.parse(row.challenge_json) as RestoreD1Challenge;
    return (
      !!m &&
      m.epoch === row.epoch &&
      m.maintenance === 1 &&
      m.gc_paused === 1 &&
      m.backup_frozen === 0 &&
      m.backup_token === null &&
      m.admission_revision === (cancelled ? row.cancel_revision : c.revision) &&
      m.admission_token === (cancelled ? row.cancel_token : c.token) &&
      m.restore_freeze_token === (cancelled ? null : row.token)
    );
  }

  async freeze(
    epoch: number,
    id: string,
    targets: RestoreFreezeTargets,
    input?: RestoreFreezeInput,
  ) {
    targets = restoreFreezeTargets(targets);
    if (input) input = structuredClone(input);
    return this.#run(epoch, id, async (current) => {
      let row = this.#row(epoch, id);
      if (!row) {
        if (!input || this.restore.inspect(epoch, id).state !== "preparing")
          throw new Error("database_restore_freeze_unverified");
        const before = this.proof(epoch, id, input);
        const c = input.challenge;
        if (
          JSON.stringify(targets) !==
          JSON.stringify(
            restoreFreezeTargets({
              target: c.target,
              blobs: before.blobs.source,
              backups: before.backups.source,
            }),
          )
        )
          throw new Error("database_restore_freeze_target_mismatch");
        // A preflight keeps ordinary unfinished work repairable. The same predicates are
        // repeated in the atomic freeze batch after the durable intent closes new repair.
        const ready = await primary(this.db)
          .prepare(
            RECOVERY_FINAL_QUERY +
              " AND c.admission_revision=? AND c.admission_token=? AND c.backup_frozen=0 AND c.backup_token IS NULL AND c.restore_freeze_token IS NULL",
          )
          .bind(epoch, c.revision, c.token)
          .first<number>();
        current();
        const after = this.proof(epoch, id, input);
        if (ready === null || JSON.stringify(before) !== JSON.stringify(after))
          throw new Error("database_restore_freeze_pending");
        const saved = this.storage.sql.exec(
          `INSERT INTO control_database_restore_freeze VALUES(?,?,?,'freezing',?,?,?, ?,NULL,NULL,NULL)
           ON CONFLICT(id) DO NOTHING RETURNING id`,
          id,
          epoch,
          crypto.randomUUID(),
          JSON.stringify(c),
          JSON.stringify(after),
          after.expiresAt,
          Date.now(),
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_freeze_conflict");
        row = this.#row(epoch, id)!;
      } else if (input) {
        const p = JSON.parse(row.proof_json) as {
          blobs: { attemptId: string };
          backups: { attemptId: string };
        };
        if (
          JSON.stringify(input.challenge) !== row.challenge_json ||
          input.blobsAttempt !== p.blobs.attemptId ||
          input.backupsAttempt !== p.backups.attemptId
        )
          throw new Error("database_restore_freeze_conflict");
      }
      if (JSON.stringify(targets) !== JSON.stringify(this.#status(row).targets))
        throw new Error("database_restore_freeze_target_mismatch");
      if (row.phase !== "freezing" && row.phase !== "frozen")
        throw new Error("database_restore_freeze_conflict");
      const c = JSON.parse(row.challenge_json) as RestoreD1Challenge;
      const observed = await primary(this.db).prepare(mirrorQuery).first<Mirror>();
      current();
      this.#same(row, row.phase);
      if (!this.#matches(observed, row)) {
        if (row.phase !== "freezing" || Date.now() >= row.expires_at)
          throw new Error("database_restore_freeze_conflict");
        try {
          await atomicBatch(this.db, [
            assertExists(
              RECOVERY_FINAL_QUERY +
                ` AND c.admission_revision=? AND c.admission_token=?
              AND c.backup_frozen=0 AND c.backup_token IS NULL AND c.restore_freeze_token IS NULL
              AND ${clock}+1000<?`,
              [epoch, c.revision, c.token, row.expires_at],
            ),
            {
              sql: "UPDATE control SET restore_freeze_token=? WHERE singleton=1",
              values: [row.token],
            },
            assertOneChange,
          ]);
        } catch {
          // A readback can establish this write barrier; it never authorizes external I/O.
        }
        current();
        this.#same(row, "freezing");
        const receipt = await primary(this.db).prepare(mirrorQuery).first<Mirror>();
        current();
        this.#same(row, "freezing");
        if (!this.#matches(receipt, row)) throw new Error("database_restore_freeze_unconfirmed");
      }
      if (row.phase === "freezing") {
        const saved = this.storage.sql.exec(
          "UPDATE control_database_restore_freeze SET phase='frozen',frozen_at=? WHERE id=? AND token=? AND phase='freezing' RETURNING id",
          Date.now(),
          id,
          row.token,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_freeze_conflict");
      }
      return this.#status(this.#row(epoch, id)!);
    });
  }

  async cancel(epoch: number, id: string) {
    return this.#run(epoch, id, async (current) => {
      let row = this.#row(epoch, id);
      if (!row) throw new Error("database_restore_freeze_missing");
      if (row.phase === "cancelled") return this.restore.inspect(epoch, id);
      const c = JSON.parse(row.challenge_json) as RestoreD1Challenge;
      if (row.phase !== "cancelling") {
        if (!Number.isSafeInteger(c.revision + 1))
          throw new Error("database_restore_freeze_conflict");
        const saved = this.storage.sql.exec(
          `UPDATE control_database_restore_freeze SET phase='cancelling',cancel_token=?,cancel_revision=?
           WHERE id=? AND token=? AND phase IN ('freezing','frozen') RETURNING id`,
          crypto.randomUUID(),
          c.revision + 1,
          id,
          row.token,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_freeze_conflict");
        row = this.#row(epoch, id)!;
      }
      const observed = await primary(this.db).prepare(mirrorQuery).first<Mirror>();
      current();
      this.#same(row, "cancelling");
      if (!this.#matches(observed, row, true)) {
        try {
          await atomicBatch(this.db, [
            assertExists(
              `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND admission_revision=?
              AND admission_token=? AND maintenance=1 AND gc_paused=1 AND backup_frozen=0 AND backup_token IS NULL
              AND (restore_freeze_token IS NULL OR restore_freeze_token=?)`,
              [epoch, c.revision, c.token, row.token],
            ),
            { sql: "UPDATE control SET restore_freeze_token=NULL WHERE singleton=1" },
            assertOneChange,
            {
              sql: `UPDATE control SET admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock}) WHERE singleton=1`,
              values: [row.cancel_revision, row.cancel_token],
            },
            assertOneChange,
          ]);
        } catch {
          // The exact new revision/token is also the cancellation fence for delayed freezes.
        }
        current();
        this.#same(row, "cancelling");
        const receipt = await primary(this.db).prepare(mirrorQuery).first<Mirror>();
        current();
        this.#same(row, "cancelling");
        if (!this.#matches(receipt, row, true))
          throw new Error("database_restore_freeze_unconfirmed");
      }
      return this.storage.transactionSync(() => {
        this.#same(row, "cancelling");
        this.admission.restoreFreezeCancelled(epoch, c.revision, c.token, row.cancel_token!);
        const saved = this.storage.sql.exec(
          "UPDATE control_database_restore_freeze SET phase='cancelled' WHERE id=? AND token=? AND phase='cancelling' RETURNING id",
          id,
          row.token,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_freeze_conflict");
        return this.restore.cancel(epoch, id);
      });
    });
  }
}
