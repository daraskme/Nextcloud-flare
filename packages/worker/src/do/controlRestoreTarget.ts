import {
  assertRestoreD1Mirror,
  RESTORE_D1_QUERY,
  RESTORE_D1_WINDOW_MS,
  type RestoreD1Challenge,
  type RestoreD1Target,
  restoreD1Challenge,
  restoreD1Target,
} from "../../../shared/src/restoreTarget";
import type { RestoreSourceAuthority } from "../backup/restoreSource";
import { primary } from "../db/primary";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";

interface TargetRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  target_json: string;
  challenge_id: string;
  revision: number | null;
  token: string | null;
  issued_at: number;
  expires_at: number;
  verified_at: number | null;
}

/** A trusted verifier's short-lived D1 observation, never an overwrite or R2 grant. */
export class ControlRestoreTarget {
  #busy = false;
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly authority: (epoch: number) => RestoreSourceAuthority,
    private readonly close: (epoch: number) => Promise<unknown>,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_target(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      target_json TEXT NOT NULL,challenge_id TEXT NOT NULL,revision INTEGER,token TEXT,
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,verified_at INTEGER
    )`);
  }

  #authority(epoch: number, id: string) {
    if (this.restore.inspect(epoch, id).state !== "preparing")
      throw new Error("database_restore_not_preparing");
    const current = this.authority(epoch);
    if (current.epoch !== epoch) throw new Error("database_restore_epoch_conflict");
    return current;
  }

  #row(id: string) {
    const row = this.sql
      .exec<TargetRow>("SELECT * FROM control_database_restore_target WHERE id=?", id)
      .toArray()[0];
    if (!row) throw new Error("database_restore_target_missing");
    return row;
  }

  #current(challenge: RestoreD1Challenge) {
    const current = this.#authority(challenge.epoch, challenge.id),
      row = this.#row(challenge.id),
      now = Date.now();
    if (
      current.revision !== challenge.revision ||
      current.token !== challenge.token ||
      row.epoch !== challenge.epoch ||
      row.challenge_id !== challenge.challengeId ||
      row.revision !== challenge.revision ||
      row.token !== challenge.token ||
      row.target_json !== JSON.stringify(challenge.target) ||
      row.issued_at !== challenge.issuedAt ||
      row.expires_at !== challenge.expiresAt
    )
      throw new Error("database_restore_target_conflict");
    if (
      now < row.issued_at ||
      now >= row.expires_at ||
      (row.verified_at !== null && now < row.verified_at)
    )
      throw new Error("database_restore_target_expired");
    return now;
  }

  async challenge(epoch: number, id: string, input: RestoreD1Target): Promise<RestoreD1Challenge> {
    if (this.#busy) throw new Error("database_restore_target_busy");
    this.#busy = true;
    try {
      const target = restoreD1Target(input),
        before = this.#authority(epoch, id),
        targetJson = JSON.stringify(target),
        issuedAt = Date.now(),
        expiresAt = issuedAt + RESTORE_D1_WINDOW_MS,
        challengeId = crypto.randomUUID();
      // Pin the target and invalidate any old observation before the first D1 await.
      const saved = this.sql.exec(
        `INSERT INTO control_database_restore_target VALUES(?,?,?,?,NULL,NULL,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET challenge_id=excluded.challenge_id,revision=NULL,token=NULL,
          issued_at=excluded.issued_at,expires_at=excluded.expires_at,verified_at=NULL
        WHERE epoch=excluded.epoch AND target_json=excluded.target_json
          AND issued_at<=excluded.issued_at AND (verified_at IS NULL OR verified_at<=excluded.issued_at)
        RETURNING id`,
        id,
        epoch,
        targetJson,
        challengeId,
        issuedAt,
        expiresAt,
      );
      if (saved.toArray().length !== 1) throw new Error("database_restore_target_conflict");
      await this.close(epoch);
      const after = this.#authority(epoch, id),
        now = Date.now();
      if (after.revision <= before.revision || after.token === before.token)
        throw new Error("database_restore_target_conflict");
      if (now < issuedAt || now >= expiresAt) throw new Error("database_restore_target_expired");
      const updated = this.sql.exec(
        `UPDATE control_database_restore_target SET revision=?,token=? WHERE id=? AND epoch=?
          AND challenge_id=? AND revision IS NULL AND token IS NULL RETURNING id`,
        after.revision,
        after.token,
        id,
        epoch,
        challengeId,
      );
      if (updated.toArray().length !== 1) throw new Error("database_restore_target_conflict");
      return {
        id,
        epoch,
        target,
        state: "d1_challenge",
        challengeId,
        revision: after.revision,
        token: after.token,
        issuedAt,
        expiresAt,
      };
    } finally {
      this.#busy = false;
    }
  }

  /** The private CLI independently read the same fresh mirror through its pinned D1 target. */
  async attest(epoch: number, id: string, input: RestoreD1Challenge) {
    if (this.#busy) throw new Error("database_restore_target_busy");
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = JSON.parse(this.#row(id).target_json) as RestoreD1Target,
        challenge = restoreD1Challenge(input, epoch, id, target);
      this.#current(challenge);
      const result = await Promise.race([
        primary(this.db).prepare(RESTORE_D1_QUERY).all(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("database_restore_target_timeout")), 10000);
        }),
      ]);
      const now = this.#current(challenge);
      assertRestoreD1Mirror(result.results, challenge);
      const saved = this.sql.exec(
        "UPDATE control_database_restore_target SET verified_at=? WHERE id=? AND challenge_id=? RETURNING id",
        now,
        id,
        challenge.challengeId,
      );
      if (saved.toArray().length !== 1) throw new Error("database_restore_target_conflict");
      return {
        id,
        epoch,
        target,
        state: "d1_verified" as const,
        validator: "d1-mirror-v1" as const,
        challengeId: challenge.challengeId,
        revision: challenge.revision,
        verifiedAt: now,
        expiresAt: challenge.expiresAt,
      };
    } finally {
      clearTimeout(timer);
      this.#busy = false;
    }
  }
}
