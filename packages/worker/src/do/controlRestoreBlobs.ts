import { type RestoreBlobsTarget, restoreBlobsTarget } from "../../../shared/src/restoreBlobs";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import {
  type BindingVerificationSource,
  withVerifiedR2Inventory,
} from "../jobs/r2BindingVerification";
import type { R2S3Inventory } from "../r2/s3Inventory";
import type { ControlRestoreTarget } from "./controlRestoreTarget";

interface BlobsRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  target_json: string;
  source_json: string;
  attempt_id: string;
  challenge_id: string;
  revision: number;
  token: string;
  issued_at: number;
  expires_at: number;
  verified_at: number | null;
}

/** Fresh BLOBS/S3 observation for one restore request; never a cached overwrite grant. */
export class ControlRestoreBlobs {
  #busy = false;
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: BindingVerificationSource,
    private readonly bucket: R2Bucket,
    private readonly target: ControlRestoreTarget,
    private readonly inventory: () => R2S3Inventory,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_blobs(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      target_json TEXT NOT NULL,source_json TEXT NOT NULL,attempt_id TEXT NOT NULL,
      challenge_id TEXT NOT NULL,revision INTEGER NOT NULL,token TEXT NOT NULL,
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,verified_at INTEGER
    )`);
  }

  observation(epoch: number, id: string, input: RestoreD1Challenge, attemptId: string) {
    const scope = this.target.verifiedScope(epoch, id, input),
      c = scope.challenge,
      now = scope.current(),
      row = this.sql
        .exec<BlobsRow>("SELECT * FROM control_database_restore_blobs WHERE id=?", id)
        .toArray()[0];
    if (
      !row ||
      row.epoch !== epoch ||
      row.attempt_id !== attemptId ||
      row.challenge_id !== c.challengeId ||
      row.target_json !== JSON.stringify(c.target) ||
      row.revision !== c.revision ||
      row.token !== c.token ||
      row.verified_at === null ||
      now < row.verified_at ||
      now >= row.expires_at ||
      row.expires_at !== c.expiresAt
    )
      throw new Error("database_restore_blobs_conflict");
    return {
      source: restoreBlobsTarget(JSON.parse(row.source_json)),
      attemptId,
      verifiedAt: row.verified_at,
      expiresAt: row.expires_at,
    };
  }

  async verify(
    epoch: number,
    id: string,
    input: RestoreD1Challenge,
    sourceInput: RestoreBlobsTarget,
  ) {
    if (this.#busy) throw new Error("database_restore_blobs_busy");
    this.#busy = true;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const source = restoreBlobsTarget(sourceInput),
        scope = this.target.verifiedScope(epoch, id, input),
        challenge = scope.challenge,
        sourceJson = JSON.stringify(source),
        targetJson = JSON.stringify(challenge.target),
        inventory = this.inventory();
      if (
        challenge.target.mode !== "remote" ||
        challenge.target.accountId !== source.accountId ||
        JSON.stringify(restoreBlobsTarget(inventory.source)) !== sourceJson
      )
        throw new Error("database_restore_blobs_target_mismatch");
      const issuedAt = scope.current(),
        attemptId = crypto.randomUUID(),
        deadline = Math.min(challenge.expiresAt, issuedAt + 25000);
      const saved = this.sql.exec(
        `INSERT INTO control_database_restore_blobs VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET attempt_id=excluded.attempt_id,challenge_id=excluded.challenge_id,
          revision=excluded.revision,token=excluded.token,issued_at=excluded.issued_at,
          expires_at=excluded.expires_at,verified_at=NULL
        WHERE epoch=excluded.epoch AND target_json=excluded.target_json AND source_json=excluded.source_json
          AND issued_at<=excluded.issued_at AND (verified_at IS NULL OR verified_at<=excluded.issued_at)
        RETURNING id`,
        id,
        epoch,
        targetJson,
        sourceJson,
        attemptId,
        challenge.challengeId,
        challenge.revision,
        challenge.token,
        issuedAt,
        challenge.expiresAt,
      );
      if (saved.toArray().length !== 1) throw new Error("database_restore_blobs_conflict");
      const current = () => {
        if (!active) throw new Error("database_restore_blobs_scope_closed");
        const now = scope.current();
        if (now < issuedAt || now >= deadline) throw new Error("database_restore_blobs_expired");
        const row = this.sql
          .exec<BlobsRow>("SELECT * FROM control_database_restore_blobs WHERE id=?", id)
          .one();
        if (
          row.attempt_id !== attemptId ||
          row.challenge_id !== challenge.challengeId ||
          row.epoch !== epoch ||
          row.source_json !== sourceJson ||
          row.target_json !== targetJson ||
          row.revision !== challenge.revision ||
          row.token !== challenge.token ||
          row.issued_at !== issuedAt ||
          row.expires_at !== challenge.expiresAt
        )
          throw new Error("database_restore_blobs_conflict");
        return now;
      };
      const run = async () => {
        await scope.readMirror();
        current();
        await withVerifiedR2Inventory(
          this.env,
          this.bucket,
          inventory,
          epoch,
          async (verified) => {
            current();
            await verified.assertCurrent();
            current();
          },
          {
            stop: { revision: challenge.revision, token: challenge.token, expiresAt: deadline },
            current,
            fence: () => {
              current();
              return scope.fence();
            },
          },
        );
        current();
        await scope.readMirror();
        const verifiedAt = current();
        const result = this.sql.exec(
          `UPDATE control_database_restore_blobs SET verified_at=?
          WHERE id=? AND attempt_id=? AND verified_at IS NULL RETURNING id`,
          verifiedAt,
          id,
          attemptId,
        );
        if (result.toArray().length !== 1) throw new Error("database_restore_blobs_conflict");
        return {
          id,
          epoch,
          target: challenge.target,
          source,
          state: "blobs_verified" as const,
          validator: "r2-binding-v1" as const,
          attemptId,
          challengeId: challenge.challengeId,
          revision: challenge.revision,
          verifiedAt,
          expiresAt: challenge.expiresAt,
        };
      };
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              active = false;
              reject(new Error("database_restore_blobs_timeout"));
            },
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
      this.#busy = false;
    }
  }
}
