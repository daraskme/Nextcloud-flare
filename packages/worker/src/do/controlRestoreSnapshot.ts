import { type RestoreFreezeTargets, restoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import {
  RESTORE_SNAPSHOT_WINDOW_MS,
  type RestoreSnapshotChallenge,
  type RestoreSnapshotProof,
  restoreSnapshotChallenge,
  restoreSnapshotProof,
} from "../../../shared/src/restoreSnapshot";
import {
  restoreTimeTravelGrant,
  restoreTimeTravelResult,
} from "../../../shared/src/restoreTimeTravel";
import { primary } from "../db/primary";
import {
  RESTORE_SNAPSHOT_CATALOGUE_QUERY,
  RESTORE_SNAPSHOT_CONTROL_QUERY,
  RESTORE_SNAPSHOT_SCHEMA_QUERY,
  restoredSnapshotMirror,
} from "../db/restoreSnapshot";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";
import type { ControlRestoreEpoch } from "./controlRestoreEpoch";

/** Read observations and a trusted isolated-SQL attestation. Never an epoch adoption grant. */
export class ControlRestoreSnapshot {
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly reservation: ControlRestoreEpoch,
    private readonly localReady: (epoch: number) => void,
  ) {}

  #row(id: string) {
    return this.sql
      .exec("SELECT * FROM control_database_restore_snapshot WHERE id=?", id)
      .toArray()[0];
  }
  #selection(epoch: number, id: string, targets: RestoreFreezeTargets) {
    this.localReady(epoch);
    const selected = this.restore.inspect(epoch, id),
      execution = this.sql
        .exec("SELECT grant_json,state FROM control_database_restore_execution WHERE id=?", id)
        .toArray()[0];
    if (
      !["restore_written", "snapshot_checking", "snapshot_verified"].includes(selected.state) ||
      selected.source.kind !== "time_travel" ||
      !selected.newEpoch ||
      !execution ||
      execution.state !== "ended"
    )
      throw new Error("database_restore_snapshot_unavailable");
    const grant = restoreTimeTravelGrant(JSON.parse(execution.grant_json as string));
    if (
      grant.id !== id ||
      grant.epoch !== epoch ||
      grant.newEpoch !== selected.newEpoch ||
      grant.bookmark !== selected.source.bookmark ||
      JSON.stringify(grant.targets) !== JSON.stringify(targets)
    )
      throw new Error("database_restore_snapshot_unavailable");
    return {
      newEpoch: selected.newEpoch,
      restoreResult: restoreTimeTravelResult(selected.restoreResult),
    };
  }
  async #mirror(current: () => void) {
    const read = async (query: string) => {
      current();
      const result = await primary(this.db).prepare(query).all<Record<string, unknown>>();
      current();
      return result.results;
    };
    const control = await read(RESTORE_SNAPSHOT_CONTROL_QUERY),
      schema = await read(RESTORE_SNAPSHOT_SCHEMA_QUERY),
      catalogue = await read(RESTORE_SNAPSHOT_CATALOGUE_QUERY);
    const result = await restoredSnapshotMirror(control, schema, catalogue);
    current();
    return result;
  }
  async #bounded<T>(run: (active: () => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      if (!active || Date.now() < started || Date.now() >= started + 25000)
        throw new Error("database_restore_snapshot_timeout");
    };
    try {
      return await Promise.race([
        run(current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_snapshot_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  async challenge(epoch: number, id: string, input: RestoreFreezeTargets) {
    const targets = restoreFreezeTargets(input),
      selected = this.#selection(epoch, id, targets),
      issuedAt = Date.now(),
      expiresAt = issuedAt + RESTORE_SNAPSHOT_WINDOW_MS,
      challengeId = crypto.randomUUID();
    const saved = this.sql.exec(
      `INSERT INTO control_database_restore_snapshot VALUES(?,?,?,?,NULL,NULL,NULL)
      ON CONFLICT(id) DO UPDATE SET challenge_id=excluded.challenge_id,issued_at=excluded.issued_at,
        expires_at=excluded.expires_at,challenge_json=NULL,proof_json=NULL,verified_at=NULL
      WHERE issued_at<=excluded.issued_at AND (verified_at IS NULL OR verified_at<=excluded.issued_at) RETURNING id`,
      id,
      challengeId,
      issuedAt,
      expiresAt,
    );
    if (saved.toArray().length !== 1) throw new Error("database_restore_snapshot_conflict");
    return this.#bounded(async (active) => {
      const current = () => {
        active();
        if (Date.now() < issuedAt || Date.now() >= expiresAt)
          throw new Error("database_restore_snapshot_expired");
        if (
          this.#row(id)?.challenge_id !== challengeId ||
          JSON.stringify(this.#selection(epoch, id, targets)) !== JSON.stringify(selected)
        )
          throw new Error("database_restore_snapshot_conflict");
      };
      current();
      await this.reservation.verifyHistory(epoch, id, targets, current);
      const mirror = await this.#mirror(current);
      const challenge = restoreSnapshotChallenge({
        id,
        epoch,
        ...selected,
        targets,
        challengeId,
        issuedAt,
        expiresAt,
        mirror,
      });
      current();
      this.sql.exec(
        "UPDATE control_database_restore_snapshot SET challenge_json=? WHERE id=? AND challenge_id=?",
        JSON.stringify(challenge),
        id,
        challengeId,
      );
      return challenge;
    });
  }

  async attest(
    epoch: number,
    id: string,
    input: RestoreSnapshotChallenge,
    evidence: RestoreSnapshotProof,
  ) {
    const challenge = restoreSnapshotChallenge(input),
      proof = restoreSnapshotProof(evidence, challenge),
      encoded = JSON.stringify(proof);
    return this.#bounded(async (active) => {
      const current = () => {
        active();
        const selected = this.#selection(epoch, id, challenge.targets),
          row = this.#row(id),
          now = Date.now();
        if (
          challenge.id !== id ||
          challenge.epoch !== epoch ||
          selected.newEpoch !== challenge.newEpoch ||
          JSON.stringify(selected.restoreResult) !== JSON.stringify(challenge.restoreResult) ||
          !row ||
          row.challenge_json !== JSON.stringify(challenge) ||
          (row.proof_json !== null && row.proof_json !== encoded)
        )
          throw new Error("database_restore_snapshot_conflict");
        if (
          now < challenge.issuedAt ||
          now >= challenge.expiresAt ||
          (typeof row.verified_at === "number" && now < row.verified_at)
        )
          throw new Error("database_restore_snapshot_expired");
      };
      current();
      await this.reservation.verifyHistory(epoch, id, challenge.targets, current);
      if (JSON.stringify(await this.#mirror(current)) !== JSON.stringify(challenge.mirror))
        throw new Error("database_restore_snapshot_changed");
      current();
      this.sql.exec(
        "UPDATE control_database_restore_snapshot SET proof_json=?,verified_at=? WHERE id=? AND challenge_id=? AND proof_json IS NULL",
        encoded,
        Date.now(),
        id,
        challenge.challengeId,
      );
      return {
        ...this.restore.inspect(epoch, id),
        validator: proof.validator,
        schemaSha256: proof.schemaSha256,
        dataSha256: proof.data.sha256,
        tables: proof.tables.length,
        bytes: proof.data.bytes,
      };
    });
  }
}
