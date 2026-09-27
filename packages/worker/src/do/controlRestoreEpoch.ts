import { type RestoreFreezeTargets, restoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import type { ControlDatabaseRestore, DatabaseRestoreSource } from "./controlDatabaseRestore";
import { ControlEpochHistory } from "./controlEpochHistory";
import type { ControlRestoreFreeze } from "./controlRestoreFreeze";
import { epochNumber, parseEpochFloor, recoverEpochFloor } from "./epochHistory";

interface EpochRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  source_json: string;
  targets_json: string;
  freeze_token: string;
  history_token: string;
  proof_json: string;
  created_at: number;
  phase: "allocating" | "writing" | "reserved";
  new_epoch: number | null;
  history_at: number | null;
}

/** Reserve history before external restoration. This class never writes or adopts D1. */
export class ControlRestoreEpoch {
  readonly #history: ControlEpochHistory;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
    private readonly restore: ControlDatabaseRestore,
    private readonly freeze: ControlRestoreFreeze,
    private readonly operatorFloor: string | undefined,
  ) {
    this.#history = new ControlEpochHistory(storage.sql, "control_restore_epoch_write");
  }

  #row(id: string) {
    return this.storage.sql
      .exec<EpochRow>("SELECT * FROM control_database_restore_epoch WHERE id=?", id)
      .toArray()[0];
  }

  #sourceProof(
    epoch: number,
    id: string,
    source: DatabaseRestoreSource,
    targets: RestoreFreezeTargets,
  ) {
    const now = Date.now();
    const proof =
      source.kind === "logical"
        ? this.storage.sql
            .exec(
              "SELECT * FROM control_database_restore_sql WHERE id=? AND epoch=? AND hash=? AND validator='logical-sql-v1'",
              id,
              epoch,
              source.manifestSha256,
            )
            .toArray()[0]
        : this.storage.sql
            .exec(
              "SELECT * FROM control_database_restore_bookmark WHERE id=? AND epoch=? AND bookmark=? AND target_json=?",
              id,
              epoch,
              source.bookmark,
              JSON.stringify(targets.target),
            )
            .toArray()[0];
    if (!proof || typeof proof.verified_at !== "number" || typeof proof.expires_at !== "number")
      throw new Error("database_restore_epoch_source_unverified");
    if (now < proof.verified_at || now >= proof.expires_at)
      throw new Error("database_restore_epoch_source_expired");
    return JSON.stringify(proof);
  }

  async reserve(epoch: number, id: string, input: RestoreFreezeTargets) {
    const targets = restoreFreezeTargets(input),
      targetsJson = JSON.stringify(targets),
      selected = this.restore.inspect(epoch, id),
      sourceJson = JSON.stringify(selected.source),
      scope = this.freeze.frozenScope(epoch, id, targets),
      started = Date.now();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      row = this.#row(id);
    const current = () => {
      if (!active) throw new Error("database_restore_epoch_timeout");
      scope.current();
      if (JSON.stringify(this.restore.inspect(epoch, id).source) !== sourceJson)
        throw new Error("database_restore_epoch_conflict");
      const found = this.#row(id);
      if (row && (!found || JSON.stringify(found) !== JSON.stringify(row)))
        throw new Error("database_restore_epoch_conflict");
      if (
        row &&
        (row.epoch !== epoch ||
          row.source_json !== sourceJson ||
          row.targets_json !== targetsJson ||
          row.freeze_token !== scope.token)
      )
        throw new Error("database_restore_epoch_conflict");
      const now = Date.now();
      if (now < started || now >= started + 25000 || (row && now < row.created_at))
        throw new Error("database_restore_epoch_timeout");
    };
    try {
      return await Promise.race([
        (async () => {
          current();
          await scope.verify();
          current();
          if (!row) {
            const proof = this.#sourceProof(epoch, id, selected.source, targets);
            current();
            const saved = this.storage.sql.exec(
              `INSERT INTO control_database_restore_epoch
               VALUES(?,?,?,?,?,?,?,?, 'allocating',NULL,NULL)
               ON CONFLICT(id) DO NOTHING RETURNING id`,
              id,
              epoch,
              sourceJson,
              targetsJson,
              scope.token,
              crypto.randomUUID(),
              proof,
              Date.now(),
            );
            if (saved.toArray().length !== 1) throw new Error("database_restore_epoch_conflict");
            row = this.#row(id)!;
          }
          if (row.phase === "allocating") {
            const lower = Math.max(
              epoch,
              selected.source.kind === "logical" ? selected.source.epoch : epoch,
            );
            const next = await recoverEpochFloor(
              this.bucket,
              lower,
              parseEpochFloor(this.operatorFloor),
              current,
            );
            current();
            this.storage.transactionSync(() => {
              const at = Date.now();
              const saved = this.storage.sql.exec(
                `UPDATE control_database_restore_epoch SET phase='writing',new_epoch=?,history_at=?
                 WHERE id=? AND history_token=? AND phase='allocating' RETURNING id`,
                next,
                at,
                id,
                row!.history_token,
              );
              if (saved.toArray().length !== 1) throw new Error("database_restore_epoch_conflict");
              this.#history.reserve({ epoch: next, at, reason: "restore" }, row!.history_token);
            });
            row = this.#row(id)!;
          }
          current();
          await this.#history.persist(
            this.bucket,
            { epoch: epochNumber(row.new_epoch), at: row.history_at!, reason: "restore" },
            row.history_token,
            current,
          );
          current();
          await scope.verify();
          current();
          if (row.phase === "writing") {
            const saved = this.storage.sql.exec(
              "UPDATE control_database_restore_epoch SET phase='reserved' WHERE id=? AND history_token=? AND phase='writing' RETURNING id",
              id,
              row.history_token,
            );
            if (saved.toArray().length !== 1) throw new Error("database_restore_epoch_conflict");
            row = this.#row(id)!;
          }
          return {
            ...this.restore.inspect(epoch, id),
            targets,
            validator: "restore-epoch-v1" as const,
            newEpoch: row.new_epoch!,
            reservedAt: row.history_at!,
          };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_epoch_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }
}
