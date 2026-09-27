import {
  type RestoreBookmarkObservation,
  restoreBookmarkObservation,
} from "../../../shared/src/restoreBookmark";
import { type RestoreFreezeTargets, restoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import {
  RESTORE_DISPATCH_MS,
  type RestoreTimeTravelGrant,
  type RestoreTimeTravelResult,
  restoreTimeTravelGrant,
  restoreTimeTravelResult,
} from "../../../shared/src/restoreTimeTravel";
import { primary } from "../db/primary";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";
import type { ControlRestoreEpoch } from "./controlRestoreEpoch";
import type { ControlRestoreFreeze } from "./controlRestoreFreeze";
import { RECOVERY_FINAL_QUERY } from "./recoveryAudit";

/** The private executor may dispatch once. Unknown outcomes retain the durable restore hold. */
export class ControlRestoreTimeTravel {
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly reservation: ControlRestoreEpoch,
    private readonly freeze: ControlRestoreFreeze,
  ) {}

  async begin(
    epoch: number,
    id: string,
    input: RestoreFreezeTargets,
    observation: RestoreBookmarkObservation & { observedAt: number },
  ) {
    const targets = restoreFreezeTargets(input),
      selected = this.restore.inspect(epoch, id);
    if (selected.state !== "epoch_reserved" || selected.source.kind !== "time_travel")
      throw new Error("database_restore_dispatch_unavailable");
    const started = Date.now(),
      source = selected.source,
      observed = restoreBookmarkObservation(observation, source.bookmark, started),
      scope = this.freeze.frozenScope(epoch, id, targets),
      saved = this.sql
        .exec("SELECT * FROM control_database_restore_epoch WHERE id=? AND phase='reserved'", id)
        .toArray()[0];
    if (!saved || JSON.parse(saved.proof_json as string).requested_timestamp !== observed.timestamp)
      throw new Error("database_restore_bookmark_mismatch");
    const observedAt = observation.observedAt;
    if (!Number.isSafeInteger(observedAt) || observedAt > started || observedAt < started - 30000)
      throw new Error("database_restore_bookmark_expired");
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      scope.current();
      const now = Date.now();
      if (!active || now < started || now >= started + 25000 || now >= observedAt + 30000)
        throw new Error("database_restore_dispatch_timeout");
      if (
        JSON.stringify(this.restore.inspect(epoch, id)) !== JSON.stringify(selected) ||
        JSON.stringify(
          this.sql.exec("SELECT * FROM control_database_restore_epoch WHERE id=?", id).toArray()[0],
        ) !== JSON.stringify(saved)
      )
        throw new Error("database_restore_execution_conflict");
    };
    try {
      return await Promise.race([
        (async () => {
          current();
          // Recheck the exact native history receipt and R2 record before external overwrite.
          await this.reservation.reserve(epoch, id, targets);
          current();
          const ready = await primary(this.db)
            .prepare(RECOVERY_FINAL_QUERY)
            .bind(epoch)
            .first<number>();
          current();
          if (ready === null) throw new Error("database_restore_dispatch_pending");
          await scope.verify();
          current();
          const issuedAt = Date.now(),
            grant = restoreTimeTravelGrant({
              validator: "time-travel-dispatch-v1",
              id,
              epoch,
              newEpoch: selected.newEpoch!,
              targets,
              bookmark: source.bookmark,
              timestamp: observed.timestamp,
              token: crypto.randomUUID(),
              issuedAt,
              expiresAt: issuedAt + RESTORE_DISPATCH_MS,
            });
          // Output gates persist this pending record before the executor can receive its token.
          this.sql.exec(
            "INSERT INTO control_database_restore_execution VALUES(?,?,'pending',NULL)",
            id,
            JSON.stringify(grant),
          );
          return grant;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_dispatch_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  /** Actual successful provider response only. No D1 access: the restored schema may differ. */
  finish(
    epoch: number,
    id: string,
    input: RestoreTimeTravelGrant,
    result: RestoreTimeTravelResult,
  ) {
    const grant = restoreTimeTravelGrant(input),
      selected = this.restore.inspect(epoch, id),
      receipt = restoreTimeTravelResult(result),
      encoded = JSON.stringify(receipt),
      row = this.sql
        .exec("SELECT * FROM control_database_restore_execution WHERE id=?", id)
        .toArray()[0];
    if (
      grant.id !== id ||
      grant.epoch !== epoch ||
      grant.newEpoch !== selected.newEpoch ||
      selected.source.kind !== "time_travel" ||
      grant.bookmark !== selected.source.bookmark ||
      !row ||
      row.grant_json !== JSON.stringify(grant) ||
      (row.result_json !== null && row.result_json !== encoded)
    )
      throw new Error("database_restore_execution_conflict");
    if (row.state === "pending")
      this.sql.exec(
        "UPDATE control_database_restore_execution SET state='ended',result_json=? WHERE id=? AND state='pending'",
        encoded,
        id,
      );
    return this.restore.inspect(epoch, id);
  }
}
