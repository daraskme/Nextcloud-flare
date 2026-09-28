import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import type { BackupInventoryCursor } from "../../../shared/src/backupRetention";
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
import type { KdfRequest } from "../auth/globalKdf";
import type {
  ImageTransformGrant,
  ImageTransformReceipt,
  ImageTransformRequest,
  ImageTransformTerminal,
} from "../db/imageTransform";
import {
  type GlobalMutationAdmission,
  isGlobalMutationId,
  isSystemMutationId,
  type MutationAdmission,
  type MutationRequest,
  type SystemMutationAdmission,
} from "../db/mutationAdmission";
import { assertOneChange, atomicBatch, primary } from "../db/primary";
import type { R2WriteGrant, R2WriteRequest, R2WriteTerminal } from "../db/r2Write";
import { type RestorePause, restorePauseCondition } from "../db/restorePause";
import type { Env } from "../env";
import {
  drainRestoreBlobGarbageCollection,
  drainStoppedBlobGarbageCollection,
  type GcResult,
} from "../jobs/gc";
import {
  abortMultipartBucketHandle,
  type MultipartBucketAbortResult,
} from "../jobs/multipartBucketAbort";
import {
  type MultipartBucketScanResult,
  type MultipartPartObservationResult,
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../jobs/multipartBucketInventory";
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
  assertNoBackup,
  type BackupBarrierStatus,
  backupActive,
  ControlBackup,
} from "./controlBackup";
import { ControlDatabaseRestore, type DatabaseRestoreSource } from "./controlDatabaseRestore";
import { ControlEpochHistory } from "./controlEpochHistory";
import { ControlImageTransforms } from "./controlImageTransforms";
import { ControlKdf } from "./controlKdf";
import { ControlMutations } from "./controlMutations";
import { CONTROL_NAME } from "./controlName";
import { ControlR2Writes } from "./controlR2Writes";
import { ControlRestoreAdoption } from "./controlRestoreAdoption";
import { ControlRestoreBackups } from "./controlRestoreBackups";
import { ControlRestoreBlobs } from "./controlRestoreBlobs";
import { ControlRestoreEpoch } from "./controlRestoreEpoch";
import { ControlRestoreFreeze, type RestoreFreezeInput } from "./controlRestoreFreeze";
import { ControlRestoreRecovery } from "./controlRestoreRecovery";
import { ControlRestoreSnapshot } from "./controlRestoreSnapshot";
import { ControlRestoreSource } from "./controlRestoreSource";
import { ControlRestoreTarget } from "./controlRestoreTarget";
import { ControlRestoreTimeTravel } from "./controlRestoreTimeTravel";
import {
  ControlShareUnlock,
  type ShareUnlockAdmission,
  type ShareUnlockAttempt,
} from "./controlShareUnlock";
import { type EpochReason, epochNumber, parseEpochFloor, recoverEpochFloor } from "./epochHistory";
import { type KdfRepairResult, KdfSettlements } from "./kdfSettlements";
import {
  failStaleRecoveryOutbox,
  inspectRecoveryFinalFence,
  inspectRecoveryPage,
  type RecoveryCursor,
  rebuildRecoverySearchFts,
  releaseStaleRecoveryReservations,
} from "./recoveryAudit";
import { repairRestoredDomain } from "./restoreDomainRepair";
import { repairRestoredInventory } from "./restoreInventoryRepair";

export { CONTROL_NAME } from "./controlName";

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
  readonly #kdf: ControlKdf;
  readonly #shareUnlock: ControlShareUnlock;
  readonly #kdfSettlements: KdfSettlements;
  readonly #mutations: ControlMutations;
  readonly #backup: ControlBackup;
  readonly #databaseRestore: ControlDatabaseRestore;
  readonly #restoreSource: ControlRestoreSource;
  readonly #restoreTarget: ControlRestoreTarget;
  readonly #restoreBlobs: ControlRestoreBlobs;
  readonly #restoreBackups: ControlRestoreBackups;
  readonly #restoreFreeze: ControlRestoreFreeze;
  readonly #restoreEpoch: ControlRestoreEpoch;
  readonly #restoreTimeTravel: ControlRestoreTimeTravel;
  readonly #restoreSnapshot: ControlRestoreSnapshot;
  readonly #restoreAdoption: ControlRestoreAdoption;
  readonly #restoreRecovery: ControlRestoreRecovery;
  readonly #r2Writes: ControlR2Writes;
  readonly #imageTransforms: ControlImageTransforms;
  readonly #epochHistory: ControlEpochHistory;
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
    this.#databaseRestore = new ControlDatabaseRestore(ctx.storage.sql);
    this.#epochHistory = new ControlEpochHistory(ctx.storage.sql);
    this.#kdfSettlements = new KdfSettlements(ctx.storage.sql, env.DB);
    this.#admission = new ControlAdmission(
      ctx.storage,
      env.DB,
      () => {
        const row = this.#row();
        if (row.phase !== "ready") throw new Error("control_not_ready");
        return epochNumber(row.epoch);
      },
      () => {
        this.#kdfSettlements.assertEmpty();
        this.#r2Writes.assertEmpty();
        this.#imageTransforms.assertEmpty();
      },
      () => this.#databaseRestore.assertInactive(),
      () => this.#databaseRestore.active(),
      () => this.#databaseRestore.assertCanRepair(),
    );
    this.#restoreSource = new ControlRestoreSource(
      ctx.storage.sql,
      env.DB,
      env.BACKUPS,
      this.#databaseRestore,
      (epoch) => this.#admission.captureDatabaseRestore(epoch),
    );
    this.#restoreTarget = new ControlRestoreTarget(
      ctx.storage.sql,
      env.DB,
      this.#databaseRestore,
      (epoch) => this.#admission.captureDatabaseRestore(epoch),
      (epoch) => this.quiesce(epoch),
    );
    this.#restoreBlobs = new ControlRestoreBlobs(
      ctx.storage.sql,
      { DB: env.DB, systemControl: this },
      env.BLOBS,
      this.#restoreTarget,
      () => new R2S3Inventory(env),
    );
    this.#restoreBackups = new ControlRestoreBackups(
      ctx.storage,
      { DB: env.DB, systemControl: this },
      env.BACKUPS,
      this.#restoreTarget,
    );
    const restoreReady = (epoch: number) => {
      const row = this.#row();
      if (row.phase !== "ready" || row.epoch !== epoch)
        throw new Error("database_restore_epoch_conflict");
      assertNoBackup(ctx.storage.sql);
      this.#kdfSettlements.assertEmpty();
      this.#r2Writes.assertEmpty();
      this.#imageTransforms.assertEmpty();
      if (ctx.storage.sql.exec("SELECT 1 FROM control_maintenance_tasks LIMIT 1").toArray().length)
        throw new Error("database_restore_maintenance_active");
    };
    this.#restoreFreeze = new ControlRestoreFreeze(
      ctx.storage,
      env.DB,
      this.#databaseRestore,
      this.#admission,
      restoreReady,
      (epoch, id, input) => {
        const { challenge, blobsAttempt, backupsAttempt } = input;
        const scope = this.#restoreTarget.verifiedScope(epoch, id, challenge);
        const blobs = this.#restoreBlobs.observation(epoch, id, challenge, blobsAttempt);
        const backups = this.#restoreBackups.observation(epoch, id, challenge, backupsAttempt);
        const expiresAt = Math.min(blobs.expiresAt, backups.expiresAt);
        if (
          JSON.stringify(blobs.source) === JSON.stringify(backups.source) ||
          scope.current() >= expiresAt
        )
          throw new Error("database_restore_freeze_unverified");
        return { blobs, backups, expiresAt };
      },
    );
    this.#restoreEpoch = new ControlRestoreEpoch(
      ctx.storage,
      env.BACKUPS,
      this.#databaseRestore,
      this.#restoreFreeze,
      env.EPOCH_FLOOR,
    );
    this.#restoreTimeTravel = new ControlRestoreTimeTravel(
      ctx.storage.sql,
      env.DB,
      this.#databaseRestore,
      this.#restoreEpoch,
      this.#restoreFreeze,
    );
    this.#restoreSnapshot = new ControlRestoreSnapshot(
      ctx.storage.sql,
      env.DB,
      this.#databaseRestore,
      this.#restoreEpoch,
      restoreReady,
    );
    this.#restoreAdoption = new ControlRestoreAdoption(
      ctx.storage,
      env.DB,
      this.#databaseRestore,
      this.#restoreSnapshot,
      this.#restoreEpoch,
      restoreReady,
      (epoch, next, token) => {
        restoreReady(epoch);
        const saved = ctx.storage.sql.exec(
          "UPDATE control_state SET epoch=? WHERE singleton=1 AND phase='ready' AND epoch=? RETURNING singleton",
          next,
          epoch,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_adoption_conflict");
        this.#admission.resetEpoch(next, token);
      },
    );
    this.#restoreRecovery = new ControlRestoreRecovery(
      ctx.storage,
      env.DB,
      this.#databaseRestore,
      this.#restoreEpoch,
      this.#admission,
      {
        current: (epoch) => {
          const row = this.#row();
          if (row.phase !== "ready" || row.epoch !== epoch)
            throw new Error("database_restore_recovery_conflict");
          assertNoBackup(ctx.storage.sql);
        },
        next: (epoch, limit) => this.nextRecoveryAuditPage(epoch, limit),
        rebuild: (epoch) => this.rebuildRecoveryFts(epoch),
        status: () => this.status(),
        repair: (epoch, action) => this.#maintenance(epoch, action),
        domain: (kind, limit, transition, current) => {
          current();
          this.#kdfSettlements.assertEmpty();
          this.#r2Writes.assertEmpty();
          this.#imageTransforms.assertEmpty();
          return repairRestoredDomain(
            ctx.storage.sql,
            env.DB,
            env.BLOBS,
            this,
            kind,
            limit,
            transition,
            current,
          );
        },
        inventory: (request, target, transition, current) => {
          current();
          this.#kdfSettlements.assertEmpty();
          this.#r2Writes.assertEmpty();
          this.#imageTransforms.assertEmpty();
          return repairRestoredInventory(
            ctx.storage.sql,
            env,
            this,
            request,
            target,
            transition,
            current,
          );
        },
        repairLive: async (limit, current) => {
          const kdf = await this.#kdfSettlements.repair(limit, current);
          current();
          const r2 = await this.#r2Writes.repair(limit, current);
          current();
          const images = await this.#imageTransforms.repair(limit, current);
          current();
          return {
            kdf,
            images,
            r2: {
              checked: r2.checked,
              reconciled: r2.reconciled,
              pending: r2.localPending,
              unknown: r2.unknown,
            },
          };
        },
      },
    );
    this.#shareUnlock = new ControlShareUnlock(ctx.storage, (epoch) =>
      this.#admission.assertMutationOpen(epoch),
    );
    this.#kdf = new ControlKdf(
      env.DB,
      async (epoch) => {
        const status = await this.status();
        if (status.maintenance || status.epoch !== epoch) throw new Error("kdf_unavailable");
      },
      (epoch) => this.#admission.assertKdfOpen(epoch),
      this.#kdfSettlements,
    );
    this.#backup = new ControlBackup(
      ctx.storage,
      env.DB,
      () => {
        this.#databaseRestore.assertInactive();
        const row = this.#row();
        if (row.phase !== "ready") throw new Error("control_not_ready");
        return row.epoch;
      },
      () => {
        // A frozen backup cannot mirror a late native completion or reopen with a pending row.
        this.#r2Writes.assertEmpty();
        this.#imageTransforms.assertEmpty();
        return this.#admission.captureBackup();
      },
      (snapshot, token) => this.#admission.restoreBackup(snapshot, token),
      env.BACKUPS,
      { DB: env.DB, systemControl: this },
      () => this.#admission.captureSystemMutationSnapshot(this.#row().epoch),
    );
    this.#mutations = new ControlMutations(
      env.DB,
      async (request) => {
        if ("system" in request) {
          if ((await this.#admission.systemMutationMode(request.epoch)) !== request.maintenance)
            throw new Error("mutation_unavailable");
          return;
        }
        const status = await this.status();
        if (status.maintenance || status.epoch !== request.epoch)
          throw new Error("mutation_unavailable");
      },
      (request) =>
        "system" in request
          ? this.#admission.assertSystemMutationMode(request.epoch, request.maintenance)
          : this.#admission.assertMutationOpen(request.epoch),
    );
    this.#r2Writes = new ControlR2Writes(
      ctx.storage,
      env.DB,
      (epoch, kind, request) => {
        if (kind.endsWith(".delete") || kind.endsWith(".abort") || kind.endsWith("probe.put"))
          this.#admission.captureSystemMutationMode(epoch);
        else this.#admission.assertMutationOpen(epoch);
        if (kind === "backups.probe.put") this.#restoreBackups.assertWrite(request);
        if (kind === "backup.delete") this.#backup.assertPruneWrite(request);
      },
      (request) => this.acquireMutation(request),
      () =>
        this.acquireGlobalMutation({
          permitId: `global:r2.write-settle:${crypto.randomUUID()}`,
          epoch: this.#row().epoch,
          deadline: Date.now() + 5000,
        }),
      (epoch, deadline, kind) =>
        this.acquireGlobalMutation({
          permitId: `global:${kind === "backup.delete" ? "r2.backups-delete" : kind === "backups.probe.put" ? "r2.backups-probe-put" : kind === "probe.put" ? "r2.probe-put" : kind.endsWith(".abort") ? "r2.multipart-abort" : kind === "manifest.delete" ? "r2.manifest-delete" : "r2.gc-delete"}:${crypto.randomUUID()}`,
          epoch,
          deadline,
        }),
    );
    this.#imageTransforms = new ControlImageTransforms(
      ctx.storage,
      env.DB,
      (epoch) => this.#admission.assertMutationOpen(epoch),
      (request) => this.acquireMutation(request),
      () =>
        this.acquireGlobalMutation({
          permitId: `global:images.settle:${crypto.randomUUID()}`,
          epoch: this.#row().epoch,
          deadline: Date.now() + 5000,
        }),
    );
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  #row(): ControlRow {
    if (this.ctx.id.toString() !== this.env.CONTROL.idFromName(CONTROL_NAME).toString()) {
      throw new Error("control_singleton_required");
    }
    const row = this.ctx.storage.sql
      .exec<ControlRow>("SELECT * FROM control_state WHERE singleton=1")
      .one();
    if (row.phase !== "pending") this.#epochHistory.assertSettled();
    return row;
  }

  async status(): Promise<ControlStatus> {
    if (backupActive(this.ctx.storage.sql) || this.#databaseRestore.active()) {
      const row = this.#row();
      if (row.phase !== "ready") throw new Error("control_not_ready");
      return { epoch: row.epoch, maintenance: true, gcPaused: true };
    }
    return this.#admission.status();
  }

  /** Pin the selection outside D1 before any I/O. Preparation never authorizes an overwrite. */
  async prepareDatabaseRestore(expectedEpoch: number, id: string, source: DatabaseRestoreSource) {
    const row = this.#row();
    const previous = this.#databaseRestore.existing(expectedEpoch, id, source);
    if (previous && previous.state !== "preparing") return previous;
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    assertNoBackup(this.ctx.storage.sql);
    this.#databaseRestore.begin(expectedEpoch, id, source);
    await this.#assertNoBackup();
    // Cancellation may have completed while the primary query was in flight.
    if (this.#databaseRestore.inspect(expectedEpoch, id).state === "cancelled")
      return this.#databaseRestore.inspect(expectedEpoch, id);
    await this.quiesce(expectedEpoch);
    return this.#databaseRestore.inspect(expectedEpoch, id);
  }

  async inspectDatabaseRestore(expectedEpoch: number, id: string) {
    this.#row();
    return this.#databaseRestore.inspect(expectedEpoch, id);
  }

  /** Freeze D1 writes after current binding checks; external restore authorization is separate. */
  async freezeDatabaseRestore(
    expectedEpoch: number,
    id: string,
    targets: RestoreFreezeTargets,
    input?: RestoreFreezeInput,
  ) {
    this.#row();
    return this.#restoreFreeze.freeze(expectedEpoch, id, targets, input);
  }

  /** Pin a future epoch in DO/R2; retain the current D1 epoch and write freeze. */
  async reserveDatabaseRestoreEpoch(
    expectedEpoch: number,
    id: string,
    targets: RestoreFreezeTargets,
  ) {
    this.#row();
    return this.#restoreEpoch.reserve(expectedEpoch, id, targets);
  }

  async beginDatabaseRestoreTimeTravel(
    expectedEpoch: number,
    id: string,
    targets: RestoreFreezeTargets,
    observation: RestoreBookmarkObservation & { observedAt: number },
  ) {
    this.#row();
    if (this.env.RESTORE_WRITE_ENABLED !== "true")
      throw new Error("database_restore_write_disabled");
    return this.#restoreTimeTravel.begin(expectedEpoch, id, targets, observation);
  }

  async finishDatabaseRestoreTimeTravel(
    expectedEpoch: number,
    id: string,
    grant: RestoreTimeTravelGrant,
    result: RestoreTimeTravelResult,
  ) {
    this.#row();
    // Turning off dispatch must not discard a late native completion for an issued grant.
    return this.#restoreTimeTravel.finish(expectedEpoch, id, grant, result);
  }

  async challengeDatabaseRestoreSnapshot(
    expectedEpoch: number,
    id: string,
    targets: RestoreFreezeTargets,
  ) {
    this.#row();
    return this.#restoreSnapshot.challenge(expectedEpoch, id, targets);
  }

  async attestDatabaseRestoreSnapshot(
    expectedEpoch: number,
    id: string,
    challenge: RestoreSnapshotChallenge,
    proof: RestoreSnapshotProof,
  ) {
    this.#row();
    return this.#restoreSnapshot.attest(expectedEpoch, id, challenge, proof);
  }

  async beginDatabaseRestoreAdoption(
    expectedEpoch: number,
    id: string,
    targets: RestoreFreezeTargets,
  ) {
    this.#row();
    return this.#restoreAdoption.begin(
      expectedEpoch,
      id,
      targets,
      this.env.RESTORE_WRITE_ENABLED === "true",
    );
  }

  async attestDatabaseRestoreAdoption(
    expectedEpoch: number,
    id: string,
    challenge: RestoreAdoptionChallenge,
  ) {
    this.#row();
    return this.#restoreAdoption.attest(expectedEpoch, id, challenge);
  }

  async auditDatabaseRestoreRecovery(expectedEpoch: number, id: string, limit = 10) {
    this.#row();
    return this.#restoreRecovery.audit(expectedEpoch, id, limit);
  }
  async repairDatabaseRestoreNative(expectedEpoch: number, id: string, limit = 10) {
    this.#row();
    return this.#restoreRecovery.repairNative(expectedEpoch, id, limit);
  }
  async repairDatabaseRestoreDomain(
    expectedEpoch: number,
    id: string,
    kind: RestoreDomainKind,
    limit = 20,
  ) {
    this.#row();
    return this.#restoreRecovery.repairDomain(
      expectedEpoch,
      id,
      kind,
      limit,
      this.env.RESTORE_WRITE_ENABLED === "true",
    );
  }
  async repairDatabaseRestoreInventory(
    expectedEpoch: number,
    id: string,
    request: RestoreInventoryRequest,
  ) {
    this.#row();
    return this.#restoreRecovery.repairInventory(
      expectedEpoch,
      id,
      request,
      this.env.RESTORE_WRITE_ENABLED === "true",
    );
  }
  async rebuildDatabaseRestoreFts(expectedEpoch: number, id: string) {
    this.#row();
    return this.#restoreRecovery.rebuild(expectedEpoch, id);
  }
  async releaseDatabaseRestoreRecovery(expectedEpoch: number, id: string) {
    this.#row();
    return this.#restoreRecovery.release(
      expectedEpoch,
      id,
      this.env.RESTORE_WRITE_ENABLED === "true",
    );
  }
  async resumeDatabaseRestoreRecovery(expectedEpoch: number, id: string) {
    this.#row();
    return this.#restoreRecovery.resume(expectedEpoch, id);
  }
  async resumeDatabaseRestoreGc(expectedEpoch: number, id: string) {
    this.#row();
    return this.#restoreRecovery.resumeGc(expectedEpoch, id);
  }

  /** Verify one immutable SQL part; this neither attests the SQL nor authorizes an overwrite. */
  async verifyDatabaseRestoreSource(expectedEpoch: number, id: string) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreSource.verify(expectedEpoch, id);
  }

  /** Private operator attestation after the isolated SQL/schema/FK verification gate. */
  async attestDatabaseRestoreSql(expectedEpoch: number, id: string, manifestSha256: string) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreSource.attest(expectedEpoch, id, manifestSha256);
  }

  /** Refresh closed admission to correlate the operator's target with our D1 binding. */
  async challengeDatabaseRestoreD1(expectedEpoch: number, id: string, target: RestoreD1Target) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreTarget.challenge(expectedEpoch, id, target);
  }

  async attestDatabaseRestoreD1(expectedEpoch: number, id: string, challenge: RestoreD1Challenge) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreTarget.attest(expectedEpoch, id, challenge);
  }

  async attestDatabaseRestoreBookmark(
    expectedEpoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    observation: RestoreBookmarkObservation,
  ) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreTarget.attestBookmark(expectedEpoch, id, challenge, observation);
  }

  async verifyDatabaseRestoreBlobs(
    expectedEpoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    source: RestoreBlobsTarget,
  ) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreBlobs.verify(expectedEpoch, id, challenge, source);
  }

  async challengeDatabaseRestoreBackups(
    expectedEpoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    source: RestoreBackupsTarget,
  ) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreBackups.challenge(expectedEpoch, id, challenge, source);
  }

  async attestDatabaseRestoreBackups(
    expectedEpoch: number,
    id: string,
    challenge: RestoreD1Challenge,
    attemptId: string,
    nonce: string,
  ) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    return this.#restoreBackups.attest(expectedEpoch, id, challenge, attemptId, nonce);
  }

  async verifyDatabaseRestoreBindings(
    expectedEpoch: number,
    id: string,
    input: RestoreD1Challenge,
    blobsAttempt: string,
    backupsAttempt: string,
  ) {
    const row = this.#row();
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    const scope = this.#restoreTarget.verifiedScope(expectedEpoch, id, input),
      challenge = scope.challenge;
    await scope.readMirror();
    const blobs = this.#restoreBlobs.observation(expectedEpoch, id, challenge, blobsAttempt),
      backups = this.#restoreBackups.observation(expectedEpoch, id, challenge, backupsAttempt);
    if (JSON.stringify(blobs.source) === JSON.stringify(backups.source))
      throw new Error("database_restore_backups_target_mismatch");
    const verifiedAt = scope.current(),
      expiresAt = Math.min(blobs.expiresAt, backups.expiresAt);
    if (verifiedAt < Math.max(blobs.verifiedAt, backups.verifiedAt) || verifiedAt >= expiresAt)
      throw new Error("database_restore_bindings_expired");
    return {
      id,
      epoch: expectedEpoch,
      target: challenge.target,
      state: "bindings_verified" as const,
      validator: "restore-bindings-v1" as const,
      challengeId: challenge.challengeId,
      revision: challenge.revision,
      blobs,
      backups,
      verifiedAt,
      expiresAt,
    };
  }

  /** Cancel preparation or its D1 freeze. Keep admission and GC closed for a new audit. */
  async cancelDatabaseRestore(expectedEpoch: number, id: string) {
    const row = this.#row();
    const previous = this.#databaseRestore.inspect(expectedEpoch, id);
    this.#databaseRestore.assertCancellable(id);
    if (previous.state === "cancelled") return previous;
    if (row.phase !== "ready" || row.epoch !== expectedEpoch)
      throw new Error("database_restore_epoch_conflict");
    if (previous.state !== "preparing") return this.#restoreFreeze.cancel(expectedEpoch, id);
    await this.#assertNoBackup();
    if (this.#databaseRestore.inspect(expectedEpoch, id).state === "cancelled")
      return this.#databaseRestore.inspect(expectedEpoch, id);
    await this.quiesce(expectedEpoch);
    return this.#databaseRestore.cancel(expectedEpoch, id);
  }

  async beginBackup(expectedEpoch: number, id: string): Promise<BackupBarrierStatus> {
    return this.#backup.begin(expectedEpoch, id);
  }

  async grantBackupPublicationWrite(
    expectedEpoch: number,
    id: string,
    request: Parameters<ControlBackup["grantPublicationWrite"]>[2],
  ) {
    return this.#backup.grantPublicationWrite(expectedEpoch, id, request);
  }

  async checkBackupPublicationWrites(
    expectedEpoch: number,
    id: string,
    generation: Parameters<ControlBackup["checkPublicationWrites"]>[2],
  ) {
    return this.#backup.checkPublicationWrites(expectedEpoch, id, generation);
  }

  async finishBackupPublicationWrite(
    expectedEpoch: number,
    id: string,
    grant: Parameters<ControlBackup["finishPublicationWrite"]>[2],
  ) {
    return this.#backup.finishPublicationWrite(expectedEpoch, id, grant);
  }

  async planDailyBackup(expectedEpoch: number, replaceCompletedId?: string) {
    return this.#backup.daily(expectedEpoch, replaceCompletedId);
  }

  async inspectBackupInventory(expectedEpoch: number, cursor?: BackupInventoryCursor) {
    return this.#backup.inventory(expectedEpoch, cursor);
  }

  async pruneBackup(expectedEpoch: number, id: string) {
    return this.#backup.prune(expectedEpoch, id);
  }

  async sweepBackups(expectedEpoch: number, round?: string) {
    return this.#backup.sweep(expectedEpoch, round);
  }

  async releaseBackup(expectedEpoch: number, id: string): Promise<BackupBarrierStatus> {
    return this.#backup.release(expectedEpoch, id);
  }

  async cancelBackup(expectedEpoch: number, id: string): Promise<BackupBarrierStatus> {
    return this.#backup.release(expectedEpoch, id, true);
  }

  /** Internal exporter RPC; a manifest hash is accepted only from the trusted SQL verifier. */
  async completeBackup(expectedEpoch: number, id: string, manifestSha256: string) {
    return this.#backup.complete(expectedEpoch, id, manifestSha256);
  }

  async #assertNoBackup(): Promise<void> {
    assertNoBackup(this.ctx.storage.sql);
    const clear = await primary(this.env.DB)
      .prepare(
        "SELECT 1 FROM control WHERE singleton=1 AND backup_token IS NULL AND backup_frozen=0",
      )
      .first();
    assertNoBackup(this.ctx.storage.sql);
    if (!clear) throw new Error("backup_active");
  }

  /** Space-scoped admission; current authorization remains in the service transaction. */
  async acquireMutation(request: MutationRequest): Promise<MutationAdmission> {
    if (typeof request.spaceId !== "string") throw new Error("mutation_unavailable");
    const admission = await this.#mutations.acquire({
      permitId: request.permitId,
      spaceId: request.spaceId,
      epoch: request.epoch,
      deadline: request.deadline,
    });
    if (admission.space_id !== request.spaceId) throw new Error("mutation_unavailable");
    return { ...admission, space_id: request.spaceId };
  }

  /** Private trusted-Worker grants, never a public R2 proxy or a replayable dispatch receipt. */
  async beginImageTransform(request: ImageTransformRequest) {
    this.#row();
    return this.#imageTransforms.begin(request);
  }
  async finishImageTransform(
    grant: ImageTransformGrant,
    outcome: ImageTransformTerminal,
    output: ImageTransformReceipt | null,
  ) {
    this.#row();
    return this.#imageTransforms.finish(grant, outcome, output);
  }
  async repairImageTransforms(expectedEpoch: number, limit = 20) {
    return this.#maintenance(expectedEpoch, () => this.#imageTransforms.repair(limit));
  }

  async beginR2Write(request: R2WriteRequest) {
    this.#row();
    return this.#r2Writes.begin(request);
  }

  async finishR2Write(grant: R2WriteGrant, outcome: R2WriteTerminal) {
    this.#row();
    return this.#r2Writes.finish(grant, outcome);
  }

  async repairR2WriteSettlements(expectedEpoch: number, limit = 20) {
    return this.#maintenance(expectedEpoch, () => this.#r2Writes.repair(limit));
  }

  /** Bootstrap shares capacity before any personal space exists. No namespace authority. */
  async acquireBootstrapMutation(
    request: Omit<MutationRequest, "spaceId">,
  ): Promise<MutationAdmission<null>> {
    const admission = await this.#mutations.acquire({
      permitId: request.permitId,
      spaceId: null,
      epoch: request.epoch,
      deadline: request.deadline,
    });
    if (admission.space_id !== null) throw new Error("mutation_unavailable");
    return { ...admission, space_id: null };
  }

  /** Typed internal facts only; this uses the very same queue and never grants namespace authority. */
  async acquireSystemMutation(request: MutationRequest): Promise<SystemMutationAdmission> {
    if (!request || typeof request.spaceId !== "string" || !isSystemMutationId(request.permitId))
      throw new Error("mutation_unavailable");
    const maintenance = this.#admission.captureSystemMutationMode(request.epoch);
    const admission = await this.#mutations.acquire({
      permitId: request.permitId,
      spaceId: request.spaceId,
      epoch: request.epoch,
      deadline: request.deadline,
      system: 1,
      maintenance,
    });
    if (
      admission.space_id !== request.spaceId ||
      admission.system !== 1 ||
      admission.maintenance !== maintenance
    )
      throw new Error("mutation_unavailable");
    return { ...admission, space_id: request.spaceId, system: 1, maintenance };
  }

  /** Ownerless internal facts use the same coordinator; callers cannot borrow a personal scope. */
  async acquireGlobalMutation(
    request: Omit<MutationRequest, "spaceId">,
  ): Promise<GlobalMutationAdmission> {
    if (!request || !isGlobalMutationId(request.permitId)) throw new Error("mutation_unavailable");
    const maintenance = this.#admission.captureSystemMutationMode(request.epoch);
    const admission = await this.#mutations.acquire({
      permitId: request.permitId,
      spaceId: null,
      epoch: request.epoch,
      deadline: request.deadline,
      system: 1,
      maintenance,
    });
    if (
      admission.space_id !== null ||
      admission.system !== 1 ||
      admission.maintenance !== maintenance
    )
      throw new Error("mutation_unavailable");
    return { ...admission, space_id: null, system: 1, maintenance };
  }

  /** Internal fixed-cost PBKDF2 only. No password or derived material is persisted. */
  async deriveKdf(request: KdfRequest): Promise<ArrayBuffer> {
    return this.#kdf.derive(request);
  }

  async admitShareUnlock(request: ShareUnlockAttempt): Promise<ShareUnlockAdmission> {
    const status = await this.status();
    if (status.maintenance || status.epoch !== request.epoch)
      throw new Error("share_unlock_unavailable");
    return this.#shareUnlock.admit(request);
  }

  /** Operator-only bounded reconciliation; unknown executions never become terminal here. */
  async repairKdfSettlements(expectedEpoch: number, limit = 20): Promise<KdfRepairResult> {
    return this.#maintenance(expectedEpoch, () => this.#kdfSettlements.repair(limit));
  }

  /** Operator/maintenance RPC only. HTTP remains closed; no public recovery endpoint. */
  async recover(): Promise<ControlStatus> {
    const row = this.#row();
    if (row.phase === "ready") return this.status();
    await this.#assertNoBackup();
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
    this.#databaseRestore.assertInactive();
    epochNumber(expectedEpoch);
    if (!["restore", "credential_rotation", "operator"].includes(reason))
      throw new Error("invalid_epoch_reason");
    await this.#assertNoBackup();
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

  async acquireRestorePause(
    expectedEpoch: number,
    operationId: string,
  ): Promise<RestorePause & { ready: boolean }> {
    this.#databaseRestore.assertInactive();
    const pause = await this.#admission.acquireRestorePause(expectedEpoch, operationId);
    await drainRestoreBlobGarbageCollection(
      { DB: this.env.DB, systemControl: this },
      this.env.BLOBS,
      pause,
    );
    const condition = restorePauseCondition(pause);
    const ready = await primary(this.env.DB)
      .prepare(`SELECT 1 FROM control c WHERE c.singleton=1
      AND c.epoch=? AND c.maintenance=0 AND c.gc_paused=1 AND ${condition.sql}
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE state='deleting')`)
      .bind(pause.epoch, ...condition.values)
      .first<number>();
    return { ...pause, ready: ready !== null };
  }

  async releaseRestorePause(expectedEpoch: number, token: string): Promise<void> {
    this.#databaseRestore.assertInactive();
    await this.#admission.releaseRestorePause(expectedEpoch, token);
  }

  async alarm(): Promise<void> {
    if (this.#row().phase !== "ready") return;
    if (backupActive(this.ctx.storage.sql) || this.#databaseRestore.active()) return;
    const transition = this.#admission.alarmTransition();
    try {
      const pause = await this.#admission.reconcileRestorePause();
      if (!pause) {
        this.#admission.restoreAlarmSucceeded(transition);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      await drainRestoreBlobGarbageCollection(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        pause,
      );
      this.#admission.restoreAlarmSucceeded(transition);
    } catch {
      // Unknown D1/R2 outcomes retain the durable intent; never infer a released window.
      if (await this.#admission.restoreAlarmFailed(transition))
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
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
      rebuildRecoverySearchFts({ DB: this.env.DB, systemControl: this }, expectedEpoch),
    );
    return this.#auditStatus(this.#auditRow(expectedEpoch));
  }

  /** Bounded stale reservation repair; upload cleanup remains a separate prerequisite. */
  async releaseStaleReservations(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ released: number; audit: RecoveryAuditStatus }> {
    const released = await this.#maintenance(expectedEpoch, () =>
      releaseStaleRecoveryReservations(
        { DB: this.env.DB, systemControl: this },
        expectedEpoch,
        limit,
      ),
    );
    return { released, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Stop mutation claims and reconcile expired single uploads without reopening admission. */
  async repairExpiredUploads(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: UploadCleanupResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      repairSingleUploads({ DB: this.env.DB, systemControl: this }, this.env.BLOBS, expectedEpoch, {
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
      repairMultipartUploads(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        expectedEpoch,
        {
          maxUploads: limit,
          maintenance: true,
        },
      ),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Finish already-claimed blob deletions while maintenance and GC pause remain set. */
  async drainBlobGarbageCollection(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: GcResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      drainStoppedBlobGarbageCollection(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        expectedEpoch,
        {
          maxBlobs: limit,
        },
      ),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Reconcile already-started orphan GC without shortening quarantine or admitting new work. */
  async drainOrphanGarbageCollection(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ cleanup: OrphanGcResult; audit: RecoveryAuditStatus }> {
    const cleanup = await this.#maintenance(expectedEpoch, () =>
      drainStoppedOrphanGarbageCollection(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        expectedEpoch,
        { limit },
      ),
    );
    return { cleanup, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Record one R2 inventory page under maintenance; no deletion or admission reopening. */
  async inventoryOrphanObjects(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ inventory: OrphanScanResult; audit: RecoveryAuditStatus }> {
    const inventory = await this.#maintenance(expectedEpoch, () =>
      scanOrphanObjects({ DB: this.env.DB, systemControl: this }, this.env.BLOBS, expectedEpoch, {
        limit,
        maintenance: true,
      }),
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
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        inventory,
        expectedEpoch,
        async (verified) => verified.observation,
      ),
    );
    return { verification, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Verify BLOBS/S3 afresh, persist/abort discovered handles, and retain unresolved reservations. */
  async repairUnidentifiedMultipartUploads(
    expectedEpoch: number,
    limit = 5,
  ): Promise<{ repair: MultipartInventoryRepairResult; audit: RecoveryAuditStatus }> {
    const inventory = new R2S3Inventory(this.env);
    const repair = await this.#maintenance(expectedEpoch, () =>
      repairUnidentifiedMultipartUploads(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        inventory,
        expectedEpoch,
        {
          maxUploads: limit,
        },
      ),
    );
    return { repair, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Persist one verified bucket page, including handles whose application rows were lost. */
  async inventoryMultipartBucket(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ inventory: MultipartBucketScanResult; audit: RecoveryAuditStatus }> {
    const client = new R2S3Inventory(this.env);
    const inventory = await this.#maintenance(expectedEpoch, () =>
      scanMultipartBucket(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        client,
        expectedEpoch,
        limit,
      ),
    );
    return { inventory, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Charge one part page conservatively; never infer that missing parts were reclaimed. */
  async observeMultipartBucketParts(
    expectedEpoch: number,
    handleId: string,
    limit = 20,
  ): Promise<{ observation: MultipartPartObservationResult; audit: RecoveryAuditStatus }> {
    const client = new R2S3Inventory(this.env);
    const observation = await this.#maintenance(expectedEpoch, () =>
      observeMultipartBucketParts(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        client,
        expectedEpoch,
        handleId,
        limit,
      ),
    );
    return { observation, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** One idempotent abort attempt; its acknowledgement never releases quarantine or bytes. */
  async abortMultipartBucketHandle(
    expectedEpoch: number,
    handleId: string,
    attemptId: string,
  ): Promise<{ abort: MultipartBucketAbortResult; audit: RecoveryAuditStatus }> {
    const client = new R2S3Inventory(this.env);
    const abort = await this.#maintenance(expectedEpoch, () =>
      abortMultipartBucketHandle(
        { DB: this.env.DB, systemControl: this },
        this.env.BLOBS,
        client,
        expectedEpoch,
        handleId,
        attemptId,
      ),
    );
    return { abort, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Bounded old-epoch node notification repair; other event kinds require their own cleanup. */
  async failStaleOutbox(
    expectedEpoch: number,
    limit = 20,
  ): Promise<{ failed: number; audit: RecoveryAuditStatus }> {
    const failed = await this.#maintenance(expectedEpoch, () =>
      failStaleRecoveryOutbox({ DB: this.env.DB, systemControl: this }, expectedEpoch, limit),
    );
    return { failed, audit: this.#auditStatus(this.#auditRow(expectedEpoch)) };
  }

  /** Checks one page; a failed page leaves the durable cursor unchanged. */
  async nextRecoveryAuditPage(expectedEpoch: number, limit = 10): Promise<RecoveryAuditStatus> {
    epochNumber(expectedEpoch);
    this.#kdfSettlements.assertEmpty();
    this.#r2Writes.assertEmpty();
    this.#imageTransforms.assertEmpty();
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
    this.#databaseRestore.assertInactive();
    assertNoBackup(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(() => {
      const at = Date.now(),
        token = crypto.randomUUID();
      const result = this.ctx.storage.sql.exec(
        `UPDATE control_state SET phase='pending',pending_epoch=?,pending_at=?,
        pending_reason=?,pending_token=? WHERE singleton=1 AND phase=? AND epoch=?`,
        epoch,
        at,
        reason,
        token,
        phase,
        expected,
      );
      if (result.rowsWritten !== 1) throw new Error("epoch_conflict");
      this.#epochHistory.reserve({ epoch, at, reason }, token);
      this.ctx.storage.sql.exec("DELETE FROM recovery_audit_v7");
    });
  }

  #assertPending(row: ControlRow): void {
    const current = this.#row();
    if (
      current.phase !== "pending" ||
      current.epoch !== row.epoch ||
      current.pending_epoch !== row.pending_epoch ||
      current.pending_at !== row.pending_at ||
      current.pending_reason !== row.pending_reason ||
      current.pending_token !== row.pending_token
    )
      throw new Error("epoch_conflict");
    this.#databaseRestore.assertInactive();
    assertNoBackup(this.ctx.storage.sql);
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
    this.#assertPending(row);
    await this.#assertNoBackup();
    this.#assertPending(row);
    await this.#epochHistory.persist(
      this.env.BACKUPS,
      { epoch: row.pending_epoch, at: row.pending_at, reason: row.pending_reason },
      row.pending_token,
      () => this.#assertPending(row),
    );
    this.#assertPending(row);
    await atomicBatch(this.env.DB, [
      {
        sql: `UPDATE control SET epoch=?,maintenance=1,gc_paused=1,gc_operator_paused=1,gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL,updated_at=?,admission_revision=0,admission_token=?
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
      this.#assertPending(row);
      const result = this.ctx.storage.sql.exec(
        `UPDATE control_state SET epoch=pending_epoch,phase='ready',
        pending_epoch=NULL,pending_at=NULL,pending_reason=NULL,pending_token=NULL
        WHERE singleton=1 AND phase='pending' AND pending_token=?`,
        row.pending_token,
      );
      if (result.rowsWritten !== 1) throw new Error("epoch_conflict");
      this.#admission.resetEpoch(row.pending_epoch!, row.pending_token!);
    });
    // Epoch recovery always closes admission; reopening requires a new complete audit.
    return this.status();
  }
}
