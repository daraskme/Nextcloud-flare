import { restoreAdoptionChallenge } from "../../../shared/src/restoreAdoption";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { ControlStatus, RecoveryAuditStatus } from "./ControlDO";
import type {
  AdmissionTransition,
  ControlAdmission,
  RecoveryReleaseProof,
} from "./controlAdmission";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";
import type { ControlRestoreEpoch } from "./controlRestoreEpoch";
import type { KdfRepairResult } from "./kdfSettlements";
import { RECOVERY_FINAL_QUERY } from "./recoveryAudit";
import { RestoreNativeRepair } from "./restoreNativeRepair";

interface RecoveryHost {
  current(epoch: number): void;
  next(epoch: number, limit: number): Promise<RecoveryAuditStatus>;
  rebuild(epoch: number): Promise<RecoveryAuditStatus>;
  status(): Promise<ControlStatus>;
  repair<T>(epoch: number, action: () => Promise<T>): Promise<T>;
  repairLive(
    limit: number,
    current: () => void,
  ): Promise<{
    kdf: KdfRepairResult;
    r2: KdfRepairResult;
  }>;
}

/** Request-scoped audit, hold release, then independent service and GC resume steps. */
export class ControlRestoreRecovery {
  readonly #native: RestoreNativeRepair;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly reservation: ControlRestoreEpoch,
    private readonly admission: ControlAdmission,
    private readonly host: RecoveryHost,
  ) {
    this.#native = new RestoreNativeRepair(storage.sql, db);
  }

  async repairNative(epoch: number, id: string, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_recovery_limit");
    const { selected } = this.#scope(epoch, id);
    const current = () => {
      const scope = this.#scope(epoch, id);
      if (scope.selected.state !== "epoch_adopted")
        throw new Error("database_restore_recovery_released");
      this.admission.assertClosed(selected.newEpoch!);
    };
    current();
    const repair = await this.host.repair(selected.newEpoch!, async () => {
      current();
      // Capture after maintenance has rotated the stop. A later stop invalidates this call.
      const stop = JSON.stringify(this.admission.captureDatabaseRestore(selected.newEpoch!));
      const stopped = () => {
        current();
        if (JSON.stringify(this.admission.captureDatabaseRestore(selected.newEpoch!)) !== stop)
          throw new Error("database_restore_recovery_conflict");
      };
      const live = await this.host.repairLive(limit, stopped);
      stopped();
      const page = await this.#native.page(id, selected.newEpoch!, limit, stopped);
      stopped();
      // Include claims outside the saved cursor and the current epoch, plus DO-only holds.
      const databasePending = await primary(this.db)
        .prepare(`SELECT
          (SELECT COUNT(*) FROM kdf_attempts WHERE state='claimed') AS kdf,
          (SELECT COUNT(*) FROM r2_write_attempts WHERE state='pending') AS r2`)
        .first<{ kdf: number; r2: number }>();
      stopped();
      if (!databasePending) throw new Error("database_restore_native_repair_unconfirmed");
      return { ...page, live, databasePending };
    });
    current();
    return { ...this.restore.inspect(epoch, id), repair };
  }

  #scope(epoch: number, id: string) {
    const selected = this.restore.inspect(epoch, id),
      adoption = this.storage.sql
        .exec(
          "SELECT challenge_json FROM control_database_restore_adoption WHERE id=? AND state='adopted'",
          id,
        )
        .toArray()[0];
    if (
      !adoption ||
      !selected.newEpoch ||
      this.storage.sql
        .exec(
          "SELECT 1 FROM control_database_restore WHERE phase='preparing' AND released_at IS NULL AND id<>?",
          id,
        )
        .toArray().length
    )
      throw new Error("database_restore_recovery_unavailable");
    const challenge = restoreAdoptionChallenge(JSON.parse(adoption.challenge_json as string));
    if (
      challenge.id !== id ||
      challenge.epoch !== epoch ||
      challenge.newEpoch !== selected.newEpoch
    )
      throw new Error("database_restore_recovery_conflict");
    this.host.current(selected.newEpoch);
    return { selected, challenge };
  }
  #release(id: string) {
    return this.storage.sql
      .exec("SELECT * FROM control_database_restore_release WHERE id=?", id)
      .toArray()[0];
  }
  #fts(id: string, epoch: number, token?: string) {
    return (
      this.storage.sql
        .exec(
          `SELECT 1 FROM control_database_restore_recovery_fts f
      JOIN recovery_audit_v7 a ON a.epoch=f.epoch AND a.token=f.audit_token
      WHERE f.id=? AND f.epoch=? AND (? IS NULL OR f.audit_token=?)`,
          id,
          epoch,
          token ?? null,
          token ?? null,
        )
        .toArray().length === 1
    );
  }
  async audit(epoch: number, id: string, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_recovery_limit");
    const { selected } = this.#scope(epoch, id);
    if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_released");
    if (!this.#fts(id, selected.newEpoch!)) return this.rebuild(epoch, id);
    const audit = await this.host.next(selected.newEpoch!, limit);
    this.#scope(epoch, id);
    return { ...this.restore.inspect(epoch, id), audit };
  }
  async rebuild(epoch: number, id: string) {
    const { selected } = this.#scope(epoch, id);
    if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_released");
    const audit = await this.host.rebuild(selected.newEpoch!);
    this.#scope(epoch, id);
    const row = this.storage.sql
      .exec(
        "SELECT token FROM recovery_audit_v7 WHERE singleton=1 AND epoch=? AND stage='users' AND pages=0",
        selected.newEpoch!,
      )
      .toArray()[0];
    if (!row) throw new Error("database_restore_recovery_conflict");
    this.storage.sql.exec(
      `INSERT INTO control_database_restore_recovery_fts VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,audit_token=excluded.audit_token`,
      id,
      selected.newEpoch!,
      row.token,
    );
    return { ...this.restore.inspect(epoch, id), audit };
  }
  async release(epoch: number, id: string, writeEnabled: boolean) {
    const { selected, challenge } = this.#scope(epoch, id);
    if (this.#release(id)) return selected;
    if (!writeEnabled) throw new Error("database_restore_write_disabled");
    const proof = this.admission.captureRecovery(selected.newEpoch!),
      encoded = JSON.stringify(proof),
      started = Date.now();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      if (
        !active ||
        started < selected.snapshotVerifiedAt! ||
        Date.now() < started ||
        Date.now() >= started + 25000
      )
        throw new Error("database_restore_recovery_timeout");
      const scope = this.#scope(epoch, id);
      if (
        !this.#fts(id, proof.epoch, proof.auditToken) ||
        JSON.stringify(scope.challenge) !== JSON.stringify(challenge) ||
        JSON.stringify(this.admission.captureRecovery(proof.epoch)) !== encoded
      )
        throw new Error("database_restore_recovery_conflict");
    };
    try {
      return await Promise.race([
        (async () => {
          current();
          await this.reservation.verifyHistory(epoch, id, challenge.targets, current);
          current();
          await atomicBatch(this.db, [
            assertExists(RECOVERY_FINAL_QUERY, [proof.epoch]),
            assertExists(
              `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND admission_revision=? AND admission_token=?
            AND maintenance=1 AND gc_paused=1 AND gc_operator_paused=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL`,
              [proof.epoch, proof.revision, proof.token],
            ),
          ]);
          current();
          this.storage.transactionSync(() => {
            current();
            if (this.#release(id)) return;
            const at = Date.now();
            this.storage.sql.exec(
              "INSERT INTO control_database_restore_release VALUES(?,?,?,NULL,NULL,NULL)",
              id,
              encoded,
              at,
            );
            const saved = this.storage.sql.exec(
              "UPDATE control_database_restore SET released_at=? WHERE id=? AND epoch=? AND released_at IS NULL RETURNING id",
              at,
              id,
              epoch,
            );
            if (saved.toArray().length !== 1) throw new Error("database_restore_recovery_conflict");
          });
          return this.restore.inspect(epoch, id);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_recovery_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }
  async resume(epoch: number, id: string) {
    this.#scope(epoch, id);
    const row = this.#release(id);
    if (!row) throw new Error("database_restore_recovery_unreleased");
    const proof = JSON.parse(row.proof_json as string) as RecoveryReleaseProof;
    const control = await this.admission.resumeRecovery(proof);
    this.#scope(epoch, id);
    if (control.maintenance || control.epoch !== proof.epoch)
      throw new Error("database_restore_recovery_conflict");
    this.storage.sql.exec(
      "UPDATE control_database_restore_release SET resumed_at=? WHERE id=? AND resumed_at IS NULL",
      Math.max(Date.now(), row.released_at as number),
      id,
    );
    return { ...this.restore.inspect(epoch, id), control };
  }
  async resumeGc(epoch: number, id: string) {
    this.#scope(epoch, id);
    let row = this.#release(id);
    if (!row || row.resumed_at === null) throw new Error("database_restore_recovery_not_resumed");
    const released = JSON.parse(row.proof_json as string) as RecoveryReleaseProof;
    if (row.gc_resumed_at !== null) {
      const control = await this.host.status();
      this.#scope(epoch, id);
      return { ...this.restore.inspect(epoch, id), control };
    }
    if (row.gc_proof_json === null) {
      const proof = this.admission.captureRecoveryGc(released.epoch, released.auditToken);
      this.storage.sql.exec(
        "UPDATE control_database_restore_release SET gc_proof_json=? WHERE id=? AND gc_proof_json IS NULL",
        JSON.stringify(proof),
        id,
      );
      row = this.#release(id)!;
    }
    const proof = JSON.parse(row.gc_proof_json as string) as AdmissionTransition;
    const control = await this.admission.resumeRecoveryGc(proof, released.auditToken);
    this.#scope(epoch, id);
    if (control.epoch !== released.epoch || control.maintenance || control.gcPaused)
      throw new Error("database_restore_recovery_conflict");
    this.storage.sql.exec(
      "UPDATE control_database_restore_release SET gc_resumed_at=? WHERE id=? AND gc_resumed_at IS NULL",
      Math.max(Date.now(), row.resumed_at as number),
      id,
    );
    return { ...this.restore.inspect(epoch, id), control };
  }
}
