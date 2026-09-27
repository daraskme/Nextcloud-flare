import { WorkerEntrypoint } from "cloudflare:workers";
import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { RestoreBackupsTarget } from "../../../shared/src/restoreBackups";
import type { RestoreBlobsTarget } from "../../../shared/src/restoreBlobs";
import type { RestoreBookmarkObservation } from "../../../shared/src/restoreBookmark";
import type { RestoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import type { RestoreD1Challenge, RestoreD1Target } from "../../../shared/src/restoreTarget";
import type { DatabaseRestoreSource } from "../do/controlDatabaseRestore";
import { CONTROL_NAME } from "../do/controlName";
import type { RestoreFreezeInput } from "../do/controlRestoreFreeze";
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
  attestBookmark(
    epoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    observation: RestoreBookmarkObservation,
  ) {
    return this.#control(epoch, id).attestDatabaseRestoreBookmark(
      epoch,
      id,
      challenge,
      observation,
    );
  }
  verifyBlobs(
    epoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    source: RestoreBlobsTarget,
  ) {
    return this.#control(epoch, id).verifyDatabaseRestoreBlobs(epoch, id, challenge, source);
  }
  cancel(epoch: number, id: string) {
    return this.#control(epoch, id).cancelDatabaseRestore(epoch, id);
  }
  freeze(epoch: number, id: string, targets: RestoreFreezeTargets, input?: RestoreFreezeInput) {
    return this.#control(epoch, id).freezeDatabaseRestore(epoch, id, targets, input);
  }
  challengeBackups(
    epoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    source: RestoreBackupsTarget,
  ) {
    return this.#control(epoch, id).challengeDatabaseRestoreBackups(epoch, id, challenge, source);
  }
  attestBackups(
    epoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    attemptId: string,
    nonce: string,
  ) {
    return this.#control(epoch, id).attestDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      attemptId,
      nonce,
    );
  }
  verifyBindings(
    epoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    blobsAttempt: string,
    backupsAttempt: string,
  ) {
    return this.#control(epoch, id).verifyDatabaseRestoreBindings(
      epoch,
      id,
      challenge,
      blobsAttempt,
      backupsAttempt,
    );
  }
  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
