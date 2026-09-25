import { WorkerEntrypoint } from "cloudflare:workers";
import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { RestoreD1Challenge, RestoreD1Target } from "../../../shared/src/restoreTarget";
import type { DatabaseRestoreSource } from "../do/controlDatabaseRestore";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";

interface RestoreOperatorProps {
  purpose?: string;
  environment?: string;
}

/** Separate private capability for a trusted restore verifier. No public HTTP or arbitrary SQL. */
export class DatabaseRestoreOperator extends WorkerEntrypoint<Env, RestoreOperatorProps> {
  #control(epoch: number, id: string) {
    if (
      this.env.RESTORE_OPERATOR_ENABLED !== "true" ||
      !["development", "staging", "production"].includes(this.env.ENVIRONMENT) ||
      this.ctx.props?.purpose !== "database-restore-v1" ||
      this.ctx.props.environment !== this.env.ENVIRONMENT
    )
      throw new Error("database_restore_operator_forbidden");
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_database_restore");
    backupManifestKey(id);
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME));
  }
  prepare(epoch: number, id: string, source: DatabaseRestoreSource) {
    return this.#control(epoch, id).prepareDatabaseRestore(epoch, id, source);
  }
  inspect(epoch: number, id: string) {
    return this.#control(epoch, id).inspectDatabaseRestore(epoch, id);
  }
  verify(epoch: number, id: string) {
    return this.#control(epoch, id).verifyDatabaseRestoreSource(epoch, id);
  }
  attest(epoch: number, id: string, manifestSha256: string) {
    return this.#control(epoch, id).attestDatabaseRestoreSql(epoch, id, manifestSha256);
  }
  challengeD1(epoch: number, id: string, target: RestoreD1Target) {
    return this.#control(epoch, id).challengeDatabaseRestoreD1(epoch, id, target);
  }
  attestD1(epoch: number, id: string, challenge: RestoreD1Challenge) {
    return this.#control(epoch, id).attestDatabaseRestoreD1(epoch, id, challenge);
  }
  cancel(epoch: number, id: string) {
    return this.#control(epoch, id).cancelDatabaseRestore(epoch, id);
  }
  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
