import { WorkerEntrypoint } from "cloudflare:workers";
import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { BackupInventoryCursor } from "../../../shared/src/backupRetention";
import { primary } from "../db/primary";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";

interface OperatorProps {
  purpose?: string;
  environment?: string;
}
export interface BackupRunReceipt {
  id: string;
  epoch: number;
  state: "pending" | "exporting" | "completed" | "failed";
  manifestKey: string | null;
  manifestSha256: string | null;
  releasedAt: number | null;
  completedAt: number | null;
}

/** Private service-binding capability for a trusted SQL verifier. Never a user HTTP API. */
export class BackupOperator extends WorkerEntrypoint<Env, OperatorProps> {
  #authorize(epoch: number): void {
    if (
      this.env.BACKUP_OPERATOR_ENABLED !== "true" ||
      !["development", "staging", "production"].includes(this.env.ENVIRONMENT) ||
      this.ctx.props?.purpose !== "logical-backup-v1" ||
      this.ctx.props.environment !== this.env.ENVIRONMENT
    )
      throw new Error("backup_operator_forbidden");
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
  }
  #control(epoch: number, id: string) {
    this.#authorize(epoch);
    backupManifestKey(id);
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME));
  }
  begin(epoch: number, id: string) {
    return this.#control(epoch, id).beginBackup(epoch, id);
  }
  daily(epoch: number) {
    this.#authorize(epoch);
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).planDailyBackup(epoch);
  }
  replenish(epoch: number, completedId: string) {
    return this.#control(epoch, completedId).planDailyBackup(epoch, completedId);
  }
  inventory(epoch: number, cursor?: BackupInventoryCursor) {
    this.#authorize(epoch);
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).inspectBackupInventory(
      epoch,
      cursor,
    );
  }
  complete(epoch: number, id: string, manifestSha256: string) {
    return this.#control(epoch, id).completeBackup(epoch, id, manifestSha256);
  }
  cancel(epoch: number, id: string) {
    return this.#control(epoch, id).cancelBackup(epoch, id);
  }
  prune(epoch: number, id: string) {
    return this.#control(epoch, id).pruneBackup(epoch, id);
  }
  sweep(epoch: number, round?: string) {
    this.#authorize(epoch);
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).sweepBackups(
      epoch,
      round,
    );
  }
  receipt(epoch: number, id: string): Promise<BackupRunReceipt | null> {
    this.#authorize(epoch);
    backupManifestKey(id);
    return primary(this.env.DB)
      .prepare(
        `SELECT id,epoch,state,manifest_key AS manifestKey,manifest_sha256 AS manifestSha256,
        released_at AS releasedAt,completed_at AS completedAt FROM backup_runs WHERE id=? AND epoch=?`,
      )
      .bind(id, epoch)
      .first<BackupRunReceipt>();
  }
  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
