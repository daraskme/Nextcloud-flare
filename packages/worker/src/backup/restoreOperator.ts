import { WorkerEntrypoint } from "cloudflare:workers";
import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { RestoreAdoptionChallenge } from "../../../shared/src/restoreAdoption";
import type { RestoreBackupsTarget } from "../../../shared/src/restoreBackups";
import type { RestoreBlobsTarget } from "../../../shared/src/restoreBlobs";
import type { RestoreBookmarkObservation } from "../../../shared/src/restoreBookmark";
import type { RestoreDomainKind } from "../../../shared/src/restoreDomain";
import type { RestoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import type { RestoreInventoryRequest } from "../../../shared/src/restoreInventory";
import type {
  RestoreSnapshotChallenge,
  RestoreSnapshotProof,
} from "../../../shared/src/restoreSnapshot";
import type { RestoreD1Challenge, RestoreD1Target } from "../../../shared/src/restoreTarget";
import type {
  RestoreTimeTravelGrant,
  RestoreTimeTravelResult,
} from "../../../shared/src/restoreTimeTravel";
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
  reserveEpoch(epoch: number, id: string, targets: RestoreFreezeTargets) {
    return this.#control(epoch, id).reserveDatabaseRestoreEpoch(epoch, id, targets);
  }
  challengeSnapshot(epoch: number, id: string, targets: RestoreFreezeTargets) {
    return this.#control(epoch, id).challengeDatabaseRestoreSnapshot(epoch, id, targets);
  }
  beginAdoption(epoch: number, id: string, targets: RestoreFreezeTargets) {
    return this.#control(epoch, id).beginDatabaseRestoreAdoption(epoch, id, targets);
  }
  attestAdoption(epoch: number, id: string, challenge: RestoreAdoptionChallenge) {
    return this.#control(epoch, id).attestDatabaseRestoreAdoption(epoch, id, challenge);
  }
  auditRecovery(epoch: number, id: string, limit = 10) {
    return this.#control(epoch, id).auditDatabaseRestoreRecovery(epoch, id, limit);
  }
  repairNative(epoch: number, id: string, limit = 10) {
    return this.#control(epoch, id).repairDatabaseRestoreNative(epoch, id, limit);
  }
  repairDomain(epoch: number, id: string, kind: RestoreDomainKind, limit = 20) {
    return this.#control(epoch, id).repairDatabaseRestoreDomain(epoch, id, kind, limit);
  }
  repairInventory(epoch: number, id: string, request: RestoreInventoryRequest) {
    return this.#control(epoch, id).repairDatabaseRestoreInventory(epoch, id, request);
  }
  rebuildRecoveryFts(epoch: number, id: string) {
    return this.#control(epoch, id).rebuildDatabaseRestoreFts(epoch, id);
  }
  releaseRecovery(epoch: number, id: string) {
    return this.#control(epoch, id).releaseDatabaseRestoreRecovery(epoch, id);
  }
  resumeRecovery(epoch: number, id: string) {
    return this.#control(epoch, id).resumeDatabaseRestoreRecovery(epoch, id);
  }
  resumeRecoveryGc(epoch: number, id: string) {
    return this.#control(epoch, id).resumeDatabaseRestoreGc(epoch, id);
  }
  attestSnapshot(
    epoch: number,
    id: string,
    challenge: RestoreSnapshotChallenge,
    proof: RestoreSnapshotProof,
  ) {
    return this.#control(epoch, id).attestDatabaseRestoreSnapshot(epoch, id, challenge, proof);
  }
  beginTimeTravel(
    epoch: number,
    id: string,
    targets: RestoreFreezeTargets,
    observation: RestoreBookmarkObservation & { observedAt: number },
  ) {
    return this.#control(epoch, id).beginDatabaseRestoreTimeTravel(epoch, id, targets, observation);
  }
  finishTimeTravel(
    epoch: number,
    id: string,
    grant: RestoreTimeTravelGrant,
    result: RestoreTimeTravelResult,
  ) {
    return this.#control(epoch, id).finishDatabaseRestoreTimeTravel(epoch, id, grant, result);
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
