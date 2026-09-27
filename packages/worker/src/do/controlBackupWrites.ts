import { BACKUP_MAX_PARTS } from "../../../shared/src/backupPublication";
import type {
  BackupPublicationWrite,
  BackupPublicationWriteGrant,
} from "../../../shared/src/backupPublicationWrite";

interface WriteRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  generation_id: string;
  epoch: number;
  barrier_token: string;
  object_key: string;
  bytes: number;
  sha256: string;
  settlement_token: string;
  state: "pending" | "ended";
}
export function initializeBackupWrites(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup_writes(
    attempt_id TEXT PRIMARY KEY,generation_id TEXT NOT NULL,epoch INTEGER NOT NULL,
    barrier_token TEXT NOT NULL,object_key TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),
    sha256 TEXT NOT NULL,settlement_token TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','ended'))
  )`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS control_backup_one_pending_write
    ON control_backup_writes(state) WHERE state='pending'`);
}
export function pendingBackupWrite(sql: SqlStorage): boolean {
  return (
    sql.exec("SELECT 1 FROM control_backup_writes WHERE state='pending' LIMIT 1").toArray().length >
    0
  );
}
export function assertBackupWritesSettled(sql: SqlStorage): void {
  if (pendingBackupWrite(sql)) throw new Error("backup_publication_write_unsettled");
}

/** D1 is frozen. Its existing backup_token holds the whole generation while DO records each PUT. */
export class ControlBackupWrites {
  constructor(private readonly sql: SqlStorage) {}

  grant(request: BackupPublicationWrite): BackupPublicationWriteGrant {
    assertBackupWritesSettled(this.sql);
    if (
      this.sql
        .exec("SELECT 1 FROM control_backup_writes WHERE attempt_id=?", request.attemptId)
        .toArray().length
    )
      throw new Error("backup_publication_write_replayed");
    // Bound retry receipts as well as part count; old settled generations are removed at begin.
    if (
      this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM control_backup_writes").one()
        .count >=
      2 * (BACKUP_MAX_PARTS + 1)
    )
      throw new Error("backup_publication_write_limit");
    const token = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO control_backup_writes VALUES(?,?,?,?,?,?,?,?,'pending')",
      request.attemptId,
      request.generation.id,
      request.generation.epoch,
      request.generation.token,
      request.key,
      request.bytes,
      request.sha256,
      token,
    );
    // Never reissue an existing grant, including after a lost reply or eviction.
    return {
      attemptId: request.attemptId,
      id: request.generation.id,
      epoch: request.generation.epoch,
      token,
    };
  }

  finish(grant: BackupPublicationWriteGrant, barrierToken: string): { state: "ended" } {
    const row = this.sql
      .exec<WriteRow>("SELECT * FROM control_backup_writes WHERE attempt_id=?", grant.attemptId)
      .toArray()[0];
    if (
      !row ||
      row.generation_id !== grant.id ||
      row.epoch !== grant.epoch ||
      row.barrier_token !== barrierToken ||
      row.settlement_token !== grant.token
    )
      throw new Error("backup_publication_write_conflict");
    this.sql.exec(
      "UPDATE control_backup_writes SET state='ended' WHERE attempt_id=? AND state='pending'",
      grant.attemptId,
    );
    return { state: "ended" };
  }
}
