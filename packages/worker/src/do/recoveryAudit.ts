import { assertOneChange, atomicBatch, primary } from "../db/primary";
import { BINDING_PROBE_BYTES, BINDING_PROBE_KEY } from "../r2/bindingProbe";
import { auditOwnerLedger } from "../services/refs";
import { loadTargetManifest, type TargetManifestRecord } from "../services/targetManifest";
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
    | "fts"
    | "fence";
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
  kind: string;
  payload_ref: string;
  state: string;
  epoch: number;
  dispatch_token: string | null;
  dispatch_expires_at: number | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  operation_state: string | null;
  operation_epoch: number | null;
  operation_kind: string | null;
  node_step_id: string | null;
  operands_json: string | null;
  result_json: string | null;
}

interface ScopeRoot {
  root_node_id: string;
  owner_id: string;
  space_id: string | null;
}

async function effectiveLiveScopeRoot(db: D1Database, scope: ScopeRoot): Promise<boolean> {
  const valid = await primary(db)
    .prepare(`WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
      SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,0,'/'||n.id||'/'
      FROM nodes n WHERE n.id=? AND n.owner_id=?
      UNION ALL
      SELECT p.id,p.parent_id,p.space_id,p.owner_id,p.kind,p.deleted_at,a.depth+1,a.path||p.id||'/'
      FROM nodes p JOIN a ON p.id=a.parent_id
      WHERE a.depth<64 AND p.space_id=a.space_id AND p.owner_id=a.owner_id
        AND instr(a.path,'/'||p.id||'/')=0
    ) SELECT 1 FROM a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=?
      WHERE (? IS NULL OR sp.id=?) GROUP BY sp.id
      HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
        AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1`)
    .bind(scope.root_node_id, scope.owner_id, scope.owner_id, scope.space_id, scope.space_id)
    .first<number>();
  return valid !== null;
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
      "fence",
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
    AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
    AND NOT EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
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

/** Also asserted inside the admission transaction, not just observed before it. */
export const RECOVERY_FINAL_QUERY = `SELECT 1 FROM control c WHERE c.singleton=1 AND c.epoch=?
      AND c.maintenance=1 AND c.gc_paused=1
      AND c.gc_hold_token IS NULL AND c.gc_hold_operation IS NULL AND c.gc_hold_expires_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM reservations WHERE state='reserved')
      AND NOT EXISTS(SELECT 1 FROM uploads
        WHERE state IN ('created','receiving','uploading','completing','aborting'))
      AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.cleanup_token IS NOT NULL
        OR (u.mode='multipart' AND u.state<>'completed' AND u.multipart_cleanup_closed IS NULL)
        OR (u.cleanup_pending=1 AND NOT EXISTS(SELECT 1 FROM gc_candidates g
          JOIN blob_storage s ON s.blob_id=g.blob_id
          WHERE g.blob_id=u.blob_id AND g.state='candidate' AND s.removed_at IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM outbox
        WHERE state IN ('pending','dispatching','sent') AND epoch<>c.epoch)
      AND NOT EXISTS(SELECT 1 FROM job_leases)
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE state='deleting')
      AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE state='deleting' OR claim_token IS NOT NULL
        OR (state<>'deleted' AND (owner_key IS NULL OR epoch>c.epoch
          OR (owner_id IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=owner_key)))))
      AND NOT EXISTS(SELECT 1 FROM r2_inventory_scan WHERE lease_token IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM r2_binding_probe WHERE phase<>'idle' OR lease_token IS NOT NULL OR epoch>c.epoch)
      AND NOT EXISTS(SELECT 1 FROM multipart_inventory_scans)
      AND NOT EXISTS(SELECT 1 FROM multipart_bucket_scan s WHERE s.completed_at IS NULL OR s.epoch<>c.epoch
        OR NOT EXISTS(SELECT 1 FROM r2_binding_probe p WHERE p.source=s.source AND p.epoch=c.epoch AND p.phase='idle'))
      AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.state='quarantined'
        OR NOT EXISTS(SELECT 1 FROM r2_binding_probe p WHERE p.source=h.source)
        OR NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE b.r2_key=h.r2_key AND u.r2_upload_id=h.r2_upload_id))
      AND NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
      AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
      AND NOT EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
      AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')
      AND NOT EXISTS(SELECT 1 FROM outbox WHERE state IN ('dispatching','sent')
        AND claim_expires_at>strftime('%s','now')*1000)
      AND ((c.bootstrap_done_at IS NULL AND c.bootstrap_iss IS NULL AND c.bootstrap_sub IS NULL
        AND NOT EXISTS(SELECT 1 FROM users) AND NOT EXISTS(SELECT 1 FROM spaces))
        OR (c.bootstrap_done_at IS NOT NULL AND length(c.bootstrap_iss)>0 AND length(c.bootstrap_sub)>0
          AND EXISTS(SELECT 1 FROM users
          WHERE role='app_admin' AND disabled_at IS NULL
            AND access_iss=c.bootstrap_iss AND access_sub=c.bootstrap_sub)))`;

/** Last D1 observation before an audit is marked complete; admission stays closed. */
export async function inspectRecoveryFinalFence(db: D1Database, epoch: number): Promise<void> {
  epochNumber(epoch);
  await assertQuiesced(db, epoch);
  const ready = await primary(db).prepare(RECOVERY_FINAL_QUERY).bind(epoch).first<number>();
  if (ready === null) throw new Error("recovery_final_fence_pending");
}

/** Old-epoch node notifications cannot be safely replayed after recovery. */
export async function failStaleRecoveryOutbox(
  db: D1Database,
  epoch: number,
  limit = 20,
): Promise<number> {
  epochNumber(epoch);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("invalid_recovery_limit");
  await assertQuiesced(db, epoch);
  const clock = "strftime('%s','now')*1000";
  const rows = await primary(db)
    .prepare(`SELECT b.outbox_id FROM outbox b JOIN operations o ON o.op_id=b.op_id
      WHERE b.epoch<? AND ((b.kind='node.created' AND o.kind IN ('node.create','node.copy','dav.mkcol','dav.lock','dav.put','dav.copy','upload.complete')) OR
        (b.kind='node.updated' AND o.kind IN ('dav.put','upload.complete')) OR
        (b.kind='node.trashed' AND o.kind IN ('node.trash','dav.delete')) OR
        (b.kind='node.restored' AND o.kind='node.restore') OR
        (b.kind='node.purged' AND o.kind='node.purge') OR
        (b.kind='node.renamed' AND o.kind IN ('node.rename','node.move','dav.move')))
        AND b.state IN ('pending','dispatching','sent')
        AND o.state='committed' AND o.epoch=b.epoch
        AND EXISTS(SELECT 1 FROM operation_steps s WHERE s.op_id=o.op_id
          AND s.kind='node' AND s.affected_id=b.payload_ref)
        AND ((b.state='pending') OR (b.dispatch_token IS NOT NULL AND b.dispatch_expires_at IS NOT NULL))
        AND ((b.claim_token IS NULL AND b.claim_expires_at IS NULL) OR
          (b.claim_token IS NOT NULL AND b.claim_expires_at<=${clock}))
      ORDER BY b.outbox_id LIMIT ?`)
    .bind(epoch, limit)
    .all<{ outbox_id: string }>();
  let failed = 0;
  for (const { outbox_id } of rows.results) {
    try {
      await atomicBatch(db, [
        {
          sql: `UPDATE outbox SET state='failed',dispatch_token=NULL,dispatch_expires_at=NULL,
            claim_token=NULL,claim_expires_at=NULL,updated_at=MAX(updated_at,${clock})
            WHERE outbox_id=? AND epoch<? AND kind IN ('node.created','node.updated','node.trashed','node.restored','node.purged','node.renamed')
              AND state IN ('pending','dispatching','sent')
              AND ((state='pending') OR (dispatch_token IS NOT NULL AND dispatch_expires_at IS NOT NULL))
              AND ((claim_token IS NULL AND claim_expires_at IS NULL) OR
                (claim_token IS NOT NULL AND claim_expires_at<=${clock}))
              AND EXISTS(SELECT 1 FROM operations o WHERE o.op_id=outbox.op_id
                AND ((outbox.kind='node.created' AND o.kind IN ('node.create','node.copy','dav.mkcol','dav.lock','dav.put','dav.copy','upload.complete')) OR
                  (outbox.kind='node.updated' AND o.kind IN ('dav.put','upload.complete')) OR
                  (outbox.kind='node.trashed' AND o.kind IN ('node.trash','dav.delete')) OR
                  (outbox.kind='node.restored' AND o.kind='node.restore') OR
                  (outbox.kind='node.purged' AND o.kind='node.purge') OR
                  (outbox.kind='node.renamed' AND o.kind IN ('node.rename','node.move','dav.move')))
                AND o.state='committed' AND o.epoch=outbox.epoch
                AND EXISTS(SELECT 1 FROM operation_steps s WHERE s.op_id=o.op_id
                  AND s.kind='node' AND s.affected_id=outbox.payload_ref))
              AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=?
                AND maintenance=1 AND gc_paused=1)`,
          values: [outbox_id, epoch, epoch],
        },
        assertOneChange,
      ]);
    } catch (error) {
      const terminal = await primary(db)
        .prepare("SELECT 1 FROM outbox WHERE outbox_id=? AND epoch<? AND state='failed'")
        .bind(outbox_id, epoch)
        .first<number>();
      if (terminal === null) throw error;
    }
    failed++;
  }
  await assertQuiesced(db, epoch);
  return failed;
}

/** Upload reservations require R2-aware cleanup, including terminal uploads with unknown writes. */
export async function releaseStaleRecoveryReservations(
  db: D1Database,
  epoch: number,
  limit = 20,
): Promise<number> {
  epochNumber(epoch);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("invalid_recovery_limit");
  await assertQuiesced(db, epoch);
  const rows = await primary(db)
    .prepare(`SELECT r.id FROM reservations r WHERE r.state='reserved' AND r.epoch<?
      AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.reservation_id=r.id)
      ORDER BY r.id LIMIT ?`)
    .bind(epoch, limit)
    .all<{ id: string }>();
  let released = 0;
  for (const { id } of rows.results) {
    try {
      await atomicBatch(db, [
        {
          sql: `UPDATE reservations SET state='released' WHERE id=? AND state='reserved' AND epoch<?
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1)
            AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.reservation_id=reservations.id)`,
          values: [id, epoch, epoch],
        },
        assertOneChange,
      ]);
    } catch (error) {
      const terminal = await primary(db)
        .prepare("SELECT 1 FROM reservations WHERE id=? AND state='released' AND epoch<?")
        .bind(id, epoch)
        .first<number>();
      if (terminal === null) throw error;
    }
    released++;
  }
  await assertQuiesced(db, epoch);
  return released;
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
  if (cursor.stage === "fence") {
    if (cursor.afterId !== "") throw new Error("invalid_recovery_cursor");
    await inspectRecoveryFinalFence(db, epoch);
    return { examined: 0, next: null };
  }
  if (cursor.stage === "fts") {
    if (cursor.afterId !== "") throw new Error("invalid_recovery_cursor");
    await inspectRecoverySearchFts(db, epoch);
    return { examined: 0, next: { stage: "fence", afterId: "" } };
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
    if (!cursor.afterId) {
      const probe = await primary(db).prepare("SELECT 1 FROM r2_binding_probe").first<number>();
      if (probe !== null) {
        const object = await bucket.head(BINDING_PROBE_KEY);
        if (!object || !(await trackedBindingProbe(db, object, epoch)))
          throw new Error("recovery_binding_probe_mismatch");
      }
    }
    const listed = await bucket.list({
      limit,
      ...(cursor.afterId ? { cursor: cursor.afterId } : {}),
    });
    if (listed.objects.length > limit) throw new Error("recovery_r2_page_overflow");
    for (const object of listed.objects) {
      if (object.key === BINDING_PROBE_KEY) {
        if (!(await trackedBindingProbe(db, object, epoch)))
          throw new Error("recovery_binding_probe_mismatch");
        continue;
      }
      const blob = await primary(db)
        .prepare(`SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id
          WHERE b.r2_key=? AND b.state NOT IN ('deleting','deleted')
            AND b.size=? AND s.bytes=? AND s.r2_etag=? AND s.removed_at IS NULL`)
        .bind(object.key, object.size, object.size, object.etag)
        .first<number>();
      if (blob !== null) continue;
      const orphan = await primary(db)
        .prepare(`SELECT 1 FROM orphan_objects WHERE r2_key=? AND state='quarantined'
          AND bytes=? AND r2_etag=? AND r2_version=? AND uploaded_at=?
          AND owner_key IS NOT NULL AND claim_token IS NULL AND epoch<=?`)
        .bind(
          object.key,
          object.size,
          object.etag,
          object.version,
          object.uploaded.getTime(),
          epoch,
        )
        .first<number>();
      if (orphan !== null) continue;
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
      if (archive !== null) continue;
      if (object.key.startsWith("target-sets/")) {
        const targetSet = await primary(db)
          .prepare(`SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes
            FROM target_sets WHERE manifest_ref=?`)
          .bind(object.key)
          .first<TargetManifestRecord>();
        if (targetSet) {
          try {
            await loadTargetManifest(bucket, targetSet);
          } catch {
            throw new Error("recovery_target_manifest_mismatch");
          }
          continue;
        }
      }
      throw new Error("recovery_untracked_r2_object");
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
      .prepare(`SELECT b.outbox_id,b.kind,b.payload_ref,b.state,b.epoch,b.dispatch_token,b.dispatch_expires_at,
        b.claim_token,b.claim_expires_at,o.state AS operation_state,o.epoch AS operation_epoch,
        o.kind AS operation_kind,o.operands_json,o.result_json,
        (SELECT s.affected_id FROM operation_steps s WHERE s.op_id=o.op_id
          AND s.kind='node' LIMIT 1) AS node_step_id
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
        !(
          (row.kind === "node.created" &&
            [
              "node.create",
              "node.copy",
              "dav.mkcol",
              "dav.lock",
              "dav.put",
              "dav.copy",
              "upload.complete",
            ].includes(row.operation_kind ?? "")) ||
          (row.kind === "node.updated" &&
            ["dav.put", "upload.complete"].includes(row.operation_kind ?? "")) ||
          (row.kind === "node.trashed" &&
            ["node.trash", "dav.delete"].includes(row.operation_kind ?? "")) ||
          (row.kind === "node.restored" && row.operation_kind === "node.restore") ||
          (row.kind === "node.purged" && row.operation_kind === "node.purge") ||
          (row.kind === "node.renamed" &&
            ["node.rename", "node.move", "dav.move"].includes(row.operation_kind ?? ""))
        ) ||
        row.node_step_id !== row.payload_ref
      )
        throw new Error("recovery_outbox_provenance_mismatch");
      try {
        const operands = JSON.parse(row.operands_json ?? "null") as {
          parentId?: unknown;
          overwriteTargetId?: unknown;
          nodeId?: unknown;
        } | null;
        const result = JSON.parse(row.result_json ?? "null") as {
          status?: unknown;
          nodeId?: unknown;
        } | null;
        if (
          !operands ||
          typeof operands.parentId !== "string" ||
          (row.kind === "node.renamed" ||
          row.kind === "node.updated" ||
          row.kind === "node.trashed" ||
          row.kind === "node.restored" ||
          row.kind === "node.purged"
            ? operands.nodeId !== row.payload_ref
            : operands.nodeId !== undefined) ||
          !result ||
          result.nodeId !== row.payload_ref ||
          result.status !==
            (row.kind === "node.created"
              ? ["node.copy", "dav.copy"].includes(row.operation_kind ?? "") &&
                typeof operands.overwriteTargetId === "string"
                ? 204
                : 201
              : row.kind === "node.updated" || row.kind === "node.trashed"
                ? 204
                : row.kind === "node.restored" || row.kind === "node.purged"
                  ? 200
                  : ["node.move", "dav.move"].includes(row.operation_kind ?? "")
                    ? typeof operands.overwriteTargetId === "string"
                      ? 204
                      : 201
                    : 200)
        )
          throw new Error("recovery_outbox_provenance_mismatch");
      } catch {
        throw new Error("recovery_outbox_provenance_mismatch");
      }
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
            EXISTS(WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
              SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,0,'/'||n.id||'/'
              FROM nodes n WHERE n.id=sh.root_node_id AND n.owner_id=sh.owner_id
              UNION ALL
              SELECT p.id,p.parent_id,p.space_id,p.owner_id,p.kind,p.deleted_at,a.depth+1,a.path||p.id||'/'
              FROM nodes p JOIN a ON p.id=a.parent_id
              WHERE a.depth<64 AND p.space_id=a.space_id AND p.owner_id=a.owner_id
                AND instr(a.path,'/'||p.id||'/')=0
            ) SELECT 1 FROM a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=sh.owner_id
              GROUP BY sp.id HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
                AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1))`)
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
      const scope = await primary(db)
        .prepare(`SELECT ap.root_node_id,ap.user_id AS owner_id,NULL AS space_id
          FROM credentials c JOIN app_passwords ap ON ap.id=c.app_password_id
          WHERE c.id=? AND c.kind='app_password' AND ap.revoked_at IS NULL
            AND ap.root_node_id IS NOT NULL
          UNION ALL
          SELECT svc.root_node_id,svc.mapped_user_id AS owner_id,svc.space_id
          FROM credentials c JOIN service_principals svc ON svc.id=c.service_principal_id
          WHERE c.id=? AND c.kind='service' AND svc.disabled_at IS NULL
            AND svc.root_node_id IS NOT NULL`)
        .bind(id, id)
        .first<ScopeRoot>();
      if (scope && !(await effectiveLiveScopeRoot(db, scope)))
        throw new Error("recovery_credential_mismatch");
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

async function trackedBindingProbe(
  db: D1Database,
  object: R2Object,
  epoch: number,
): Promise<boolean> {
  if (object.key !== BINDING_PROBE_KEY || object.size !== BINDING_PROBE_BYTES) return false;
  return (
    (await primary(db)
      .prepare(`SELECT 1 FROM r2_binding_probe WHERE singleton=1
    AND phase='idle' AND lease_token IS NULL AND epoch<=? AND r2_key=? AND allocated_bytes=?
    AND r2_etag=? AND r2_version=? AND uploaded_at=?`)
      .bind(epoch, object.key, object.size, object.etag, object.version, object.uploaded.getTime())
      .first<number>()) !== null
  );
}
