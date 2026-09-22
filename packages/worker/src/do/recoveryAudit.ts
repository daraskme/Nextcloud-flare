import { primary } from "../db/primary";
import { auditOwnerLedger } from "../services/refs";
import { epochNumber } from "./epochHistory";

export interface RecoveryCursor {
  readonly stage: "users" | "blobs";
  readonly afterId: string;
}

export interface RecoveryPage {
  readonly examined: number;
  readonly next: RecoveryCursor | null;
}

interface BlobRow {
  id: string;
  r2_key: string;
  size: number;
  bytes: number | null;
  r2_etag: string | null;
  removed_at: number | null;
}

function validCursor(cursor: RecoveryCursor, limit: number): void {
  if (
    !["users", "blobs"].includes(cursor.stage) ||
    typeof cursor.afterId !== "string" ||
    cursor.afterId.length > 128 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error("invalid_recovery_cursor");
}

async function assertQuiesced(db: D1Database, epoch: number): Promise<void> {
  const gate = await primary(db)
    .prepare(`SELECT 1 FROM control WHERE singleton=1
    AND epoch=? AND maintenance=1 AND gc_paused=1
    AND NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
    AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')
    AND NOT EXISTS(SELECT 1 FROM job_leases WHERE expires_at>strftime('%s','now')*1000)
    AND NOT EXISTS(SELECT 1 FROM outbox WHERE state IN ('dispatching','sent')
      AND claim_expires_at>strftime('%s','now')*1000)
    AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE state='deleting')
    AND NOT EXISTS(SELECT 1 FROM uploads WHERE state IN ('receiving','completing'))`)
    .bind(epoch)
    .first<number>();
  if (gate === null) throw new Error("recovery_not_quiesced");
  const bootstrap = await primary(db)
    .prepare("SELECT bootstrap_done_at,bootstrap_iss,bootstrap_sub FROM control WHERE singleton=1")
    .first<{
      bootstrap_done_at: number | null;
      bootstrap_iss: string | null;
      bootstrap_sub: string | null;
    }>();
  if (!bootstrap) throw new Error("recovery_not_quiesced");
  if (bootstrap.bootstrap_done_at === null) {
    if (bootstrap.bootstrap_iss !== null || bootstrap.bootstrap_sub !== null)
      throw new Error("recovery_partial_bootstrap");
    const partial = await primary(db)
      .prepare(`SELECT 1 FROM users
      UNION ALL SELECT 1 FROM spaces LIMIT 1`)
      .first<number>();
    if (partial !== null) throw new Error("recovery_partial_bootstrap");
  } else {
    if (!bootstrap.bootstrap_iss || !bootstrap.bootstrap_sub)
      throw new Error("recovery_bootstrap_mismatch");
    const admin = await primary(db)
      .prepare(`SELECT 1 FROM users
      WHERE role='app_admin' AND disabled_at IS NULL AND access_iss=? AND access_sub=? LIMIT 1`)
      .bind(bootstrap.bootstrap_iss, bootstrap.bootstrap_sub)
      .first<number>();
    if (admin === null) throw new Error("recovery_bootstrap_mismatch");
  }
}

/** One bounded diagnostic page. A caller must not treat a page or cursor as resume authority. */
export async function inspectRecoveryPage(
  db: D1Database,
  bucket: R2Bucket,
  epoch: number,
  cursor: RecoveryCursor,
  limit = 10,
): Promise<RecoveryPage> {
  epochNumber(epoch);
  validCursor(cursor, limit);
  await assertQuiesced(db, epoch);
  if (cursor.stage === "users") {
    const rows = await primary(db)
      .prepare(`SELECT id FROM users WHERE id>? ORDER BY id LIMIT ?`)
      .bind(cursor.afterId, limit + 1)
      .all<{ id: string }>();
    const page = rows.results.slice(0, limit);
    for (const { id } of page) {
      const root = await primary(db)
        .prepare(`SELECT 1 FROM spaces s JOIN nodes n ON n.id=s.root_node_id
        WHERE s.owner_id=? AND n.space_id=s.id AND n.owner_id=s.owner_id
          AND n.kind='root' AND n.parent_id IS NULL AND n.deleted_at IS NULL`)
        .bind(id)
        .first<number>();
      if (root === null) throw new Error("recovery_root_mismatch");
      const audit = await auditOwnerLedger(db, id);
      if (
        !audit ||
        audit.used_bytes !== audit.actual_used_bytes ||
        audit.reserved_bytes !== audit.actual_reserved_bytes ||
        audit.physical_bytes !== audit.observed_physical_bytes ||
        audit.incorrect_refs !== 0
      )
        throw new Error("recovery_ledger_mismatch");
    }
    return {
      examined: page.length,
      next:
        rows.results.length > limit
          ? { stage: "users", afterId: page.at(-1)?.id ?? cursor.afterId }
          : { stage: "blobs", afterId: "" },
    };
  }
  const rows = await primary(db)
    .prepare(`SELECT b.id,b.r2_key,b.size,s.bytes,s.r2_etag,s.removed_at
    FROM blobs b LEFT JOIN blob_storage s ON s.blob_id=b.id
    WHERE b.id>? AND b.state IN ('committed','gc_candidate') ORDER BY b.id LIMIT ?`)
    .bind(cursor.afterId, limit + 1)
    .all<BlobRow>();
  const page = rows.results.slice(0, limit);
  for (const blob of page) {
    if (blob.bytes !== blob.size || !blob.r2_etag || blob.removed_at !== null)
      throw new Error("recovery_physical_mismatch");
    const object = await bucket.head(blob.r2_key);
    if (!object || object.size !== blob.size || object.etag !== blob.r2_etag)
      throw new Error("recovery_r2_mismatch");
  }
  return {
    examined: page.length,
    next:
      rows.results.length > limit
        ? { stage: "blobs", afterId: page.at(-1)?.id ?? cursor.afterId }
        : null,
  };
}
