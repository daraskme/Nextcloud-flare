import { primary } from "../db/primary";
import { reindexAudioNode } from "../jobs/audioSearchReindex";
import { AUDIO_SEARCH_VERSION } from "../search/audio";
import type { SystemMutationSource } from "../services/systemMutation";

export const AUDIO_REINDEX_SCAN_LIMIT = 32;
export const AUDIO_REINDEX_WRITE_LIMIT = 8;
export const AUDIO_REINDEX_PAGE_SQL = `SELECT node_id FROM node_audio
  WHERE node_id>? AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=?
    AND maintenance=0 AND backup_token IS NULL AND restore_freeze_token IS NULL)
  ORDER BY node_id LIMIT ?`;
export interface AudioReindexProgress {
  checked: number;
  repaired: number;
  current: number;
  unavailable: number;
  failed: number;
  wrapped: boolean;
  busy: boolean;
}

/** A repeating primary-key walk: only derived progress lives here, never raw user metadata. */
export class ControlAudioSearch {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: SystemMutationSource,
    private readonly current: (epoch: number) => void,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS audio_search_walk(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      version TEXT NOT NULL,after_id TEXT NOT NULL,token TEXT,expires_at INTEGER NOT NULL)`);
  }

  async run(epoch: number, deadline = Date.now() + 5000): Promise<AudioReindexProgress> {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 1 ||
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      deadline > Date.now() + 5000
    )
      throw new Error("invalid_audio_reindex");
    this.current(epoch);
    const sql = this.storage.sql,
      version = AUDIO_SEARCH_VERSION,
      token = crypto.randomUUID();
    const result: AudioReindexProgress = {
      checked: 0,
      repaired: 0,
      current: 0,
      unavailable: 0,
      failed: 0,
      wrapped: false,
      busy: false,
    };
    const lease = this.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO audio_search_walk VALUES(1,?,?,'',NULL,0)
        ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,version=excluded.version,
          after_id='',token=NULL,expires_at=0
        WHERE audio_search_walk.epoch<>excluded.epoch OR audio_search_walk.version<>excluded.version`,
        epoch,
        version,
      );
      return sql
        .exec<{ after_id: string }>(
          `UPDATE audio_search_walk SET token=?,expires_at=?
        WHERE singleton=1 AND (token IS NULL OR expires_at<=?) RETURNING after_id`,
          token,
          deadline,
          Date.now(),
        )
        .toArray()[0];
    });
    if (!lease) return { ...result, busy: true };
    const active = () => {
      this.current(epoch);
      return (
        Date.now() < deadline &&
        sql
          .exec(
            `SELECT 1 FROM audio_search_walk
        WHERE singleton=1 AND epoch=? AND version=? AND token=?`,
            epoch,
            version,
            token,
          )
          .toArray().length === 1
      );
    };
    try {
      const page = await primary(this.env.DB)
        .prepare(AUDIO_REINDEX_PAGE_SQL)
        .bind(lease.after_id, epoch, AUDIO_REINDEX_SCAN_LIMIT + 1)
        .all<{ node_id: string }>();
      for (const row of page.results.slice(0, AUDIO_REINDEX_SCAN_LIMIT)) {
        if (
          !active() ||
          result.repaired + result.unavailable + result.failed >= AUDIO_REINDEX_WRITE_LIMIT
        )
          break;
        // Advance before work: one malformed/conflicting row cannot starve later rows.
        // A crash or unknown commit is revisited on the next walk; current rows are no-ops.
        sql.exec(
          "UPDATE audio_search_walk SET after_id=? WHERE singleton=1 AND token=?",
          row.node_id,
          token,
        );
        result.checked++;
        try {
          const outcome = await reindexAudioNode(this.env, epoch, row.node_id, deadline);
          result[outcome]++;
        } catch {
          result.failed++;
        }
      }
      if (active() && result.checked === page.results.length) {
        sql.exec("UPDATE audio_search_walk SET after_id='' WHERE singleton=1 AND token=?", token);
        result.wrapped = true;
      }
      return result;
    } finally {
      // A late request must never release a replacement lease or rewind its cursor.
      sql.exec(
        "UPDATE audio_search_walk SET token=NULL,expires_at=0 WHERE singleton=1 AND token=?",
        token,
      );
    }
  }
}
