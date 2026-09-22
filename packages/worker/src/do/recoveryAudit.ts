import { primary } from "../db/primary";
import { auditOwnerLedger } from "../services/refs";
import { epochNumber } from "./epochHistory";

export interface RecoveryCursor {
  readonly stage:
    | "users"
    | "blobs"
    | "r2"
    | "outbox"
    | "shares"
    | "credentials"
    | "credential_sources"
    | "fts";
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

interface OutboxRow {
  outbox_id: string;
  state: string;
  epoch: number;
  dispatch_token: string | null;
  dispatch_expires_at: number | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  operation_state: string | null;
  operation_epoch: number | null;
}

function validCursor(cursor: RecoveryCursor, limit: number): void {
  if (
    ![
      "users",
      "blobs",
      "r2",
      "outbox",
      "shares",
      "credentials",
      "credential_sources",
      "fts",
    ].includes(cursor.stage) ||
    typeof cursor.afterId !== "string" ||
    cursor.afterId.length >
      (cursor.stage === "r2" ? 8192 : cursor.stage === "credential_sources" ? 2048 : 128) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error("invalid_recovery_cursor");
}

const credentialSources = [
  {
    tag: "a",
    table: "sessions",
    condition: "kind='access'",
    column: "session_id",
    kind: "access",
    idPrefix: "as:",
  },
  {
    tag: "p",
    table: "app_passwords",
    condition: "1=1",
    column: "app_password_id",
    kind: "app_password",
    idPrefix: "ap:",
  },
  {
    tag: "s",
    table: "share_sessions",
    condition: "1=1",
    column: "share_session_id",
    kind: "share",
    idPrefix: "ss:",
  },
  {
    tag: "v",
    table: "service_principals",
    condition: "1=1",
    column: "service_principal_id",
    kind: "service",
    idPrefix: "sv:",
  },
] as const;

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

/** FTS5 compares its external-content index with search_index only when rank=1. */
export async function inspectRecoverySearchFts(db: D1Database, epoch: number): Promise<void> {
  epochNumber(epoch);
  await assertQuiesced(db, epoch);
  await primary(db)
    .prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)")
    .run();
  await assertQuiesced(db, epoch);
}

/** Operator repair after restore; an ambiguous rebuild response is checked before retrying. */
export async function rebuildRecoverySearchFts(db: D1Database, epoch: number): Promise<void> {
  epochNumber(epoch);
  await assertQuiesced(db, epoch);
  try {
    await primary(db).prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run();
  } catch (error) {
    try {
      await inspectRecoverySearchFts(db, epoch);
      return;
    } catch {
      throw error;
    }
  }
  await inspectRecoverySearchFts(db, epoch);
}

/** One diagnostic stage; row pages are bounded, while FTS integrity checks its whole index. */
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
  if (cursor.stage === "fts") {
    if (cursor.afterId !== "") throw new Error("invalid_recovery_cursor");
    await inspectRecoverySearchFts(db, epoch);
    return { examined: 0, next: null };
  }
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
  if (cursor.stage === "r2") {
    const listed = await bucket.list({
      limit,
      ...(cursor.afterId ? { cursor: cursor.afterId } : {}),
    });
    if (listed.objects.length > limit) throw new Error("recovery_r2_page_overflow");
    for (const object of listed.objects) {
      const blob = await primary(db)
        .prepare(`SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id
          WHERE b.r2_key=? AND b.state NOT IN ('deleting','deleted')
            AND b.size=? AND s.bytes=? AND s.r2_etag=? AND s.removed_at IS NULL`)
        .bind(object.key, object.size, object.size, object.etag)
        .first<number>();
      if (blob !== null) continue;
      const derivative = await primary(db)
        .prepare(`SELECT 1 FROM derivative_results
          WHERE r2_key=? AND state='ready' AND size=?`)
        .bind(object.key, object.size)
        .first<number>();
      if (derivative !== null) continue;
      const archive = await primary(db)
        .prepare("SELECT 1 FROM archive_index WHERE r2_key=? AND json_bytes=?")
        .bind(object.key, object.size)
        .first<number>();
      if (archive === null) throw new Error("recovery_untracked_r2_object");
    }
    if (listed.truncated && (!listed.cursor || listed.cursor === cursor.afterId))
      throw new Error("recovery_r2_cursor_stalled");
    return {
      examined: listed.objects.length,
      next: listed.truncated
        ? { stage: "r2", afterId: listed.cursor ?? "" }
        : { stage: "outbox", afterId: "" },
    };
  }
  if (cursor.stage === "credential_sources") {
    const tag = cursor.afterId ? cursor.afterId.slice(0, 2) : "a:";
    const sourceIndex = credentialSources.findIndex((source) => `${source.tag}:` === tag);
    if (sourceIndex < 0) throw new Error("invalid_recovery_cursor");
    const source = credentialSources[sourceIndex];
    if (!source) throw new Error("invalid_recovery_cursor");
    const afterId = cursor.afterId ? cursor.afterId.slice(2) : "";
    const rows = await primary(db)
      .prepare(
        `SELECT id FROM ${source.table} WHERE ${source.condition} AND id>? ORDER BY id LIMIT ?`,
      )
      .bind(afterId, limit + 1)
      .all<{ id: string }>();
    const page = rows.results.slice(0, limit);
    for (const { id } of page) {
      const valid = await primary(db)
        .prepare(`SELECT 1 FROM credentials WHERE id=? AND kind=? AND ${source.column}=?`)
        .bind(`${source.idPrefix}${id}`, source.kind, id)
        .first<number>();
      if (valid === null) throw new Error("recovery_credential_registry_missing");
    }
    const nextSource = credentialSources[sourceIndex + 1];
    return {
      examined: page.length,
      next:
        rows.results.length > limit
          ? { stage: "credential_sources", afterId: `${source.tag}:${page.at(-1)?.id ?? afterId}` }
          : nextSource
            ? { stage: "credential_sources", afterId: `${nextSource.tag}:` }
            : { stage: "fts", afterId: "" },
    };
  }
  if (cursor.stage === "outbox") {
    const rows = await primary(db)
      .prepare(`SELECT b.outbox_id,b.state,b.epoch,b.dispatch_token,b.dispatch_expires_at,
        b.claim_token,b.claim_expires_at,o.state AS operation_state,o.epoch AS operation_epoch
      FROM outbox b LEFT JOIN operations o ON o.op_id=b.op_id
      WHERE b.outbox_id>? ORDER BY b.outbox_id LIMIT ?`)
      .bind(cursor.afterId, limit + 1)
      .all<OutboxRow>();
    const page = rows.results.slice(0, limit);
    for (const row of page) {
      if (row.operation_state === null || row.operation_epoch !== row.epoch)
        throw new Error("recovery_outbox_provenance_mismatch");
      if (
        ["pending", "dispatching", "sent", "completed"].includes(row.state) &&
        row.operation_state !== "committed"
      )
        throw new Error("recovery_outbox_provenance_mismatch");
      if (
        (row.state === "dispatching" || row.state === "sent") &&
        (!row.dispatch_token || row.dispatch_expires_at === null)
      )
        throw new Error("recovery_outbox_dispatch_mismatch");
      if ((row.claim_token === null) !== (row.claim_expires_at === null))
        throw new Error("recovery_outbox_claim_mismatch");
    }
    return {
      examined: page.length,
      next:
        rows.results.length > limit
          ? { stage: "outbox", afterId: page.at(-1)?.outbox_id ?? cursor.afterId }
          : { stage: "shares", afterId: "" },
    };
  }
  if (cursor.stage === "shares") {
    const rows = await primary(db)
      .prepare("SELECT id FROM shares WHERE id>? ORDER BY id LIMIT ?")
      .bind(cursor.afterId, limit + 1)
      .all<{ id: string }>();
    const page = rows.results.slice(0, limit);
    for (const { id } of page) {
      const valid = await primary(db)
        .prepare(`SELECT 1 FROM shares sh WHERE sh.id=?
          AND sh.reserved_bytes=COALESCE((SELECT SUM(r.bytes) FROM reservations r
            WHERE r.share_id=sh.id AND r.state='reserved'),0)
          AND NOT EXISTS(SELECT 1 FROM share_grants g
            WHERE g.share_id=sh.id AND g.version>sh.version)
          AND NOT EXISTS(SELECT 1 FROM share_sessions ss
            WHERE ss.share_id=sh.id AND ss.share_version>sh.version)
          AND (sh.disabled_at IS NOT NULL OR
            (sh.expires_at IS NOT NULL AND sh.expires_at<=strftime('%s','now')*1000) OR
            EXISTS(SELECT 1 FROM nodes n JOIN spaces sp ON sp.id=n.space_id
              WHERE n.id=sh.root_node_id AND n.owner_id=sh.owner_id
                AND sp.owner_id=sh.owner_id AND n.deleted_at IS NULL))`)
        .bind(id)
        .first<number>();
      if (valid === null) throw new Error("recovery_share_mismatch");
    }
    return {
      examined: page.length,
      next:
        rows.results.length > limit
          ? { stage: "shares", afterId: page.at(-1)?.id ?? cursor.afterId }
          : { stage: "credentials", afterId: "" },
    };
  }
  if (cursor.stage === "credentials") {
    const rows = await primary(db)
      .prepare("SELECT id FROM credentials WHERE id>? ORDER BY id LIMIT ?")
      .bind(cursor.afterId, limit + 1)
      .all<{ id: string }>();
    const page = rows.results.slice(0, limit);
    for (const { id } of page) {
      const valid = await primary(db)
        .prepare(`SELECT 1 FROM credentials c WHERE c.id=? AND (
          (c.kind='access' AND EXISTS(SELECT 1 FROM sessions s
            WHERE s.id=c.session_id AND s.kind='access')) OR
          (c.kind='app_password' AND EXISTS(SELECT 1 FROM app_passwords ap
            WHERE ap.id=c.app_password_id AND (ap.revoked_at IS NOT NULL OR
              ap.root_node_id IS NULL OR EXISTS(SELECT 1 FROM nodes n
                WHERE n.id=ap.root_node_id AND n.owner_id=ap.user_id AND n.deleted_at IS NULL)))) OR
          (c.kind='share' AND EXISTS(SELECT 1 FROM share_sessions ss
            JOIN shares sh ON sh.id=ss.share_id
            WHERE ss.id=c.share_session_id AND ss.share_version<=sh.version)) OR
          (c.kind='service' AND EXISTS(SELECT 1 FROM service_principals svc
            JOIN spaces sp ON sp.id=svc.space_id AND sp.owner_id=svc.mapped_user_id
            WHERE svc.id=c.service_principal_id AND (svc.disabled_at IS NOT NULL OR
              EXISTS(SELECT 1 FROM nodes n WHERE n.id=svc.root_node_id
                AND n.space_id=svc.space_id AND n.owner_id=svc.mapped_user_id
                AND n.deleted_at IS NULL))))
        )`)
        .bind(id)
        .first<number>();
      if (valid === null) throw new Error("recovery_credential_mismatch");
    }
    return {
      examined: page.length,
      next:
        rows.results.length > limit
          ? { stage: "credentials", afterId: page.at(-1)?.id ?? cursor.afterId }
          : { stage: "credential_sources", afterId: "" },
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
        : { stage: "r2", afterId: "" },
  };
}
