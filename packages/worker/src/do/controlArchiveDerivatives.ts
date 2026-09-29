import {
  type ArchiveDerivativeGrant,
  type ArchiveDerivativeReceipt,
  archiveDerivativeAuthority,
  archiveDerivativeKey,
  archiveGrantFromRow,
  archiveGrantJson,
  archiveOutputJson,
} from "../db/archiveDerivative";
import type { GlobalMutationAdmission } from "../db/mutationAdmission";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { globalMutationStatements } from "../services/globalMutation";
import { NativeHistory, nativeIdentity } from "./nativeHistory";

export function initializeArchiveOrigins(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS control_archive_derivative_origins(
    id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, output_json TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS control_archive_derivative_seals(
    archive_id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE)`);
  for (const table of ["control_archive_derivative_origins", "control_archive_derivative_seals"])
    for (const action of ["UPDATE", "DELETE"])
      sql.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'archive_derivative_history_required'); END`);
}

/** Independent preparation predates every writer; seals remain effective after D1 restoration. */
export function assertArchiveOrigin(
  sql: SqlStorage,
  g: ArchiveDerivativeGrant,
  outputJson: string,
  allowSealed = false,
) {
  const key = archiveDerivativeKey(g),
    original = sql
      .exec<{ grant_json: string; output_json: string; r2_key: string }>(
        "SELECT grant_json,output_json,r2_key FROM control_archive_derivative_origins WHERE id=?",
        g.id,
      )
      .toArray()[0];
  if (
    !original ||
    original.grant_json !== archiveGrantJson(g) ||
    original.output_json !== outputJson ||
    original.r2_key !== key
  )
    throw new Error("archive_storage_history_missing");
  if (
    !allowSealed &&
    sql
      .exec(
        "SELECT 1 FROM control_archive_derivative_seals WHERE archive_id=? OR r2_key=?",
        g.id,
        key,
      )
      .toArray().length
  )
    throw new Error("archive_derivative_retired");
}

export class ControlArchiveDerivatives {
  readonly #history: NativeHistory;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly current: (epoch: number) => void,
    private readonly admit: () => Promise<GlobalMutationAdmission>,
  ) {
    initializeArchiveOrigins(storage.sql);
    this.#history = new NativeHistory(storage.sql);
  }

  async remember(g: ArchiveDerivativeGrant, output: ArchiveDerivativeReceipt) {
    const grantJson = archiveGrantJson(g),
      outputJson = archiveOutputJson(output);
    g = JSON.parse(grantJson) as ArchiveDerivativeGrant;
    const now = Date.now();
    if (g.expiresAt <= now || g.expiresAt > now + 25000)
      throw new Error("archive_derivative_expired");
    this.current(g.epoch);
    await atomicBatch(this.db, await archiveDerivativeAuthority(this.db, g));
    this.current(g.epoch);
    if (Date.now() >= g.expiresAt) throw new Error("archive_derivative_expired");
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO control_archive_derivative_origins VALUES(?,?,?,?)",
      g.id,
      archiveDerivativeKey(g),
      grantJson,
      outputJson,
    );
    assertArchiveOrigin(this.storage.sql, g, outputJson);
  }

  /** Read-only publication proof; never a new native dispatch grant. */
  async publicationProof(epoch: number, id: string) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-f0-9-]{36}$/.test(id))
      throw new Error("invalid_archive_publication");
    this.current(epoch);
    const row = await primary(this.db)
      .prepare(`SELECT x.* FROM archive_derivative_objects x
      JOIN archive_derivative_cleanup c ON c.archive_id=x.id WHERE x.id=? AND x.state IN ('stored','published') AND c.retired_at IS NULL`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("archive_publication_unproven");
    const g = archiveGrantFromRow(row),
      key = archiveDerivativeKey(g);
    if (g.epoch !== epoch) throw new Error("archive_publication_unproven");
    const writes = await primary(this.db)
      .prepare(`SELECT * FROM r2_write_attempts WHERE kind='archive.put'
      AND state='succeeded' AND epoch=? AND owner_id=? AND r2_key=? AND source_ref=? LIMIT 2`)
      .bind(epoch, g.ownerId, key, JSON.stringify([id, row.write_attempt_id]))
      .all<Record<string, unknown>>();
    if (writes.results.length !== 1) throw new Error("archive_publication_unproven");
    const w = writes.results[0]!,
      identity = await nativeIdentity("r2", [
        w.id,
        w.token,
        w.epoch,
        w.owner_id,
        w.kind,
        w.r2_key,
        w.dispatch_before,
        w.started_at,
        w.source_ref,
      ]);
    this.current(epoch);
    const proof = this.#history.find(identity),
      sql = this.storage.sql;
    if (proof?.outcome !== "succeeded" || proof.deadline !== w.dispatch_before)
      throw new Error("archive_storage_history_missing");
    assertArchiveOrigin(sql, g, row.output_json as string);
    if (
      sql
        .exec(
          "SELECT 1 FROM control_r2_write_receipts WHERE state='pending' AND json_extract(grant_json,'$.key')=? LIMIT 1",
          key,
        )
        .toArray().length
    )
      throw new Error("archive_storage_unsettled");
    return {
      archiveId: id,
      key,
      outputJson: row.output_json as string,
      writeId: w.id as string,
      writeToken: w.token as string,
    };
  }

  async seal(epoch: number, id: string) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-f0-9-]{36}$/.test(id))
      throw new Error("invalid_archive_seal");
    this.current(epoch);
    const row = await primary(this.db)
      .prepare(`SELECT x.* FROM archive_derivative_objects x JOIN archive_derivative_cleanup c ON c.archive_id=x.id
      WHERE x.id=? AND c.retired_at IS NOT NULL`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("archive_seal_unavailable");
    const g = archiveGrantFromRow(row),
      key = archiveDerivativeKey(g);
    if (g.epoch > epoch) throw new Error("archive_seal_unavailable");
    this.current(epoch);
    const sql = this.storage.sql;
    assertArchiveOrigin(sql, g, row.output_json as string, true);
    const token = this.storage.transactionSync(() => {
      if (
        sql
          .exec(
            "SELECT 1 FROM control_r2_write_receipts WHERE state='pending' AND json_extract(grant_json,'$.key')=? LIMIT 1",
            key,
          )
          .toArray().length
      )
        throw new Error("archive_storage_unsettled");
      sql.exec(
        "INSERT OR IGNORE INTO control_archive_derivative_seals VALUES(?,?,?)",
        id,
        key,
        crypto.randomUUID(),
      );
      const saved = sql
        .exec<{ token: string; r2_key: string }>(
          "SELECT token,r2_key FROM control_archive_derivative_seals WHERE archive_id=?",
          id,
        )
        .toArray()[0];
      if (saved?.r2_key !== key) throw new Error("archive_seal_conflict");
      return saved.token;
    });
    const admission = await this.admit();
    this.current(epoch);
    try {
      await atomicBatch(
        this.db,
        globalMutationStatements(admission, [
          assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [epoch]),
          assertExists(
            "SELECT 1 FROM archive_derivative_objects WHERE id=? AND source_json=? AND output_json=?",
            [id, row.source_json as string, row.output_json as string],
          ),
          assertExists(
            "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')",
            [key],
          ),
          {
            sql: "UPDATE archive_derivative_cleanup SET seal_token=? WHERE archive_id=? AND retired_at IS NOT NULL AND settled_at IS NULL AND (seal_token IS NULL OR seal_token=?)",
            values: [token, id, token],
          },
          assertOneChange,
        ]),
      );
    } catch (error) {
      if (
        !(await primary(this.db)
          .prepare(
            "SELECT 1 FROM archive_derivative_cleanup WHERE archive_id=? AND seal_token=? AND retired_at IS NOT NULL",
          )
          .bind(id, token)
          .first())
      )
        throw error;
    }
    this.current(epoch);
    return { token, key };
  }
}
