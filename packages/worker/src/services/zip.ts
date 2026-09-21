import { LIMITS } from "@ncf/shared";

import type { AuthenticatedUser } from "../auth/httpAuth.js";
import type { AuthenticatedShare } from "../auth/share.js";
import { randomToken, sha256 } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { acquireBudget, attachBudgetLease, hasOwnerBudgetCapacity } from "./budgets.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { assertShareNode, findInternalShare, type ShareCapability } from "./shares.js";
import { createStoreZipStream, measureStoreZipMetadata, type StoreZipSource } from "./zipStore.js";

const ZIP_TTL_MS = 10 * 60 * 1000;

interface ZipEntry {
  nodeId: string;
  blobId: string;
  key: string;
  name: string;
  size: number;
}

interface ZipManifestRow {
  id: string;
  ownerId: string;
  issuerSessionId: string;
  shareId: string | null;
  shareVersion: number | null;
  rootNodeId: string;
  entriesJson: string;
  manifestHash: string;
  outputSize: number;
  budgetId: string;
  maxBytes: number;
  expiresAt: number;
}

function safeDownloadName(name: string): string {
  const value = name.replaceAll('"', "_").replaceAll("\\", "_") || "download";
  return `${value}.zip`;
}

async function entriesForRoot(env: Env, ownerId: string, rootNodeId: string): Promise<ZipEntry[]> {
  const rows = await env.DB.prepare(
    "WITH RECURSIVE sub(id,path,depth) AS (SELECT id,CASE WHEN name='' THEN 'download' ELSE name END,0 FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL UNION ALL SELECT n.id,sub.path||'/'||n.name,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND sub.depth<64 LIMIT 1002) SELECT n.id nodeId,n.current_blob_id blobId,b.r2_key key,sub.path name,b.size FROM sub JOIN nodes n ON n.id=sub.id JOIN blobs b ON b.id=n.current_blob_id WHERE n.kind='file' AND b.state='committed' ORDER BY sub.path,n.id",
  )
    .bind(rootNodeId, ownerId)
    .all<ZipEntry>();
  if (rows.results.length > 1000) throw new Error("zip_entry_limit");
  const names = new Set<string>();
  for (const entry of rows.results) {
    if (
      names.has(entry.name) ||
      entry.name.startsWith("/") ||
      entry.name.includes("../") ||
      entry.name.includes("\\") ||
      new TextEncoder().encode(entry.name).byteLength > 1024
    ) {
      throw new Error("zip_path_invalid");
    }
    names.add(entry.name);
  }
  return rows.results;
}

async function createManifest(
  env: Env,
  input: {
    ownerId: string;
    issuerSessionId: string;
    share: ShareCapability | null;
    rootNodeId: string;
    budgetId: string;
    maxBytes?: number;
  },
): Promise<{ id: string; size: number; expiresAt: number }> {
  if (!(await hasOwnerBudgetCapacity(env, input.ownerId))) throw new Error("budget_owner_limit");
  const ownerRoot = await env.DB.prepare(
    "SELECT s.root_node_id rootId FROM spaces s JOIN nodes n ON n.space_id=s.id WHERE n.id=?1 AND n.owner_id=?2",
  )
    .bind(input.rootNodeId, input.ownerId)
    .first<{ rootId: string }>();
  if (ownerRoot === null || !(await isEffectiveLive(env, input.rootNodeId, ownerRoot.rootId))) {
    throw new Error("node_not_found");
  }
  const entries = await entriesForRoot(env, input.ownerId, input.rootNodeId);
  const outputSize = measureStoreZipMetadata(entries);
  if (outputSize > LIMITS.zip32MaxBytes) throw new Error("zip_too_large");
  const maxBytes = input.maxBytes ?? outputSize * 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < outputSize)
    throw new Error("zip_budget_invalid");
  const id = `zip_${randomToken(18)}`;
  const now = Date.now();
  const expiresAt = Math.min(now + ZIP_TTL_MS, input.share?.expiresAt ?? Number.MAX_SAFE_INTEGER);
  const entriesJson = JSON.stringify(entries);
  const manifestHash = await sha256(entriesJson);
  const uniqueBlobIds = [...new Set(entries.map((entry) => entry.blobId))];
  const pins = uniqueBlobIds.map((blobId) => ({ pinId: `${id}:${blobId}`, blobId }));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND revoked_at IS NULL AND expires_at>?2)",
    ).bind(input.issuerSessionId, now),
    ...(input.share === null
      ? []
      : [
          env.DB.prepare(
            "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares WHERE id=?1 AND version=?2 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?3))",
          ).bind(input.share.id, input.share.version, now),
        ]),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?1) e JOIN nodes n ON n.id=json_extract(e.value,'$.nodeId') JOIN blobs b ON b.id=json_extract(e.value,'$.blobId') AND b.id=n.current_blob_id WHERE n.owner_id=?2 AND n.deleted_at IS NULL AND b.state='committed')<>?3",
    ).bind(entriesJson, input.ownerId, entries.length),
    env.DB.prepare(
      "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) SELECT json_extract(value,'$.pinId'),json_extract(value,'$.blobId'),'zip',?1,?2 FROM json_each(?3)",
    ).bind(expiresAt, now, JSON.stringify(pins)),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?1").bind(pins.length),
    env.DB.prepare(
      "UPDATE blobs SET ref_count=ref_count+1 WHERE id IN (SELECT json_extract(value,'$.blobId') FROM json_each(?1)) AND state='committed'",
    ).bind(JSON.stringify(pins)),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?1").bind(pins.length),
    env.DB.prepare(
      "INSERT INTO zip_manifests(id,owner_id,issuer_session_id,share_id,share_version,root_node_id,entries_json,manifest_hash,output_size,budget_id,max_bytes,expires_at,canceled_at,completed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,NULL,?13)",
    ).bind(
      id,
      input.ownerId,
      input.issuerSessionId,
      input.share?.id ?? null,
      input.share?.version ?? null,
      input.rootNodeId,
      entriesJson,
      manifestHash,
      outputSize,
      input.budgetId,
      maxBytes,
      expiresAt,
      now,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return { id, size: outputSize, expiresAt };
}

export async function createUserZip(
  env: Env,
  user: AuthenticatedUser,
  rootNodeId: string,
): Promise<{ id: string; size: number; expiresAt: number }> {
  const owner = await env.DB.prepare(
    "SELECT owner_id ownerId FROM nodes WHERE id=?1 AND deleted_at IS NULL",
  )
    .bind(rootNodeId)
    .first<{ ownerId: string }>();
  if (owner === null) throw new Error("node_not_found");
  let share: ShareCapability | null = null;
  if (owner.ownerId !== user.principal.userId) {
    share = await findInternalShare(env, user.principal.userId, rootNodeId, "download");
    if (share === null) throw new Error("node_not_found");
  }
  return createManifest(env, {
    ownerId: owner.ownerId,
    issuerSessionId: user.principal.sessionId,
    share,
    rootNodeId,
    budgetId:
      share === null ? `u:${user.principal.userId}` : `u:${user.principal.userId}:s:${share.id}`,
  });
}

export async function createShareZip(
  env: Env,
  authentication: AuthenticatedShare,
  rootNodeId: string,
): Promise<{ id: string; size: number; expiresAt: number }> {
  await assertShareNode(env, authentication.share, rootNodeId, "download");
  return createManifest(env, {
    ownerId: authentication.share.ownerId,
    issuerSessionId: authentication.sessionId,
    share: authentication.share,
    rootNodeId,
    budgetId: authentication.budgetId,
    maxBytes: authentication.budgetMaxBytes,
  });
}

async function releasePins(
  env: Env,
  manifestId: string,
  completed: boolean,
  now = Date.now(),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE blobs SET ref_count=ref_count-1 WHERE ref_count>0 AND id IN (SELECT blob_id FROM blob_pins WHERE substr(pin_id,1,length(?1))=?1 AND purpose='zip')",
    ).bind(`${manifestId}:`),
    env.DB.prepare(
      "DELETE FROM blob_pins WHERE substr(pin_id,1,length(?1))=?1 AND purpose='zip'",
    ).bind(`${manifestId}:`),
    env.DB.prepare(
      completed
        ? "UPDATE zip_manifests SET completed_at=COALESCE(completed_at,?1) WHERE id=?2"
        : "UPDATE zip_manifests SET canceled_at=COALESCE(canceled_at,?1) WHERE id=?2 AND completed_at IS NULL",
    ).bind(now, manifestId),
  ]);
}

async function loadManifest(env: Env, id: string): Promise<ZipManifestRow> {
  const row = await env.DB.prepare(
    "SELECT id,owner_id ownerId,issuer_session_id issuerSessionId,share_id shareId,share_version shareVersion,root_node_id rootNodeId,entries_json entriesJson,manifest_hash manifestHash,output_size outputSize,budget_id budgetId,max_bytes maxBytes,expires_at expiresAt FROM zip_manifests WHERE id=?1 AND canceled_at IS NULL AND completed_at IS NULL AND expires_at>(strftime('%s','now')*1000)",
  )
    .bind(id)
    .first<ZipManifestRow>();
  if (row === null || (await sha256(row.entriesJson)) !== row.manifestHash) {
    throw new Error("zip_not_found");
  }
  return row;
}

async function serveManifest(env: Env, row: ZipManifestRow): Promise<Response> {
  const ownerRoot = await env.DB.prepare("SELECT root_node_id rootId FROM spaces WHERE owner_id=?1")
    .bind(row.ownerId)
    .first<{ rootId: string }>();
  if (ownerRoot === null || !(await isEffectiveLive(env, row.rootNodeId, ownerRoot.rootId))) {
    throw new Error("zip_not_found");
  }
  const entries = JSON.parse(row.entriesJson) as ZipEntry[];
  const live = await env.DB.prepare(
    "SELECT COUNT(*) count FROM json_each(?1) e JOIN nodes n ON n.id=json_extract(e.value,'$.nodeId') JOIN blobs b ON b.id=json_extract(e.value,'$.blobId') AND b.id=n.current_blob_id JOIN blob_pins p ON p.blob_id=b.id AND p.pin_id=?2||':'||b.id WHERE n.owner_id=?3 AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(row.entriesJson, row.id, row.ownerId)
    .first<{ count: number }>();
  if (live?.count !== entries.length) throw new Error("zip_stale");
  const lease = await acquireBudget(env, row.budgetId, row.maxBytes, row.outputSize);
  try {
    const sources: StoreZipSource[] = entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      stream: async () => {
        const object = await env.BLOBS.get(entry.key);
        if (object === null || object.size !== entry.size) throw new Error("content_inconsistent");
        return object.body;
      },
    }));
    const root = await env.DB.prepare("SELECT name FROM nodes WHERE id=?1")
      .bind(row.rootNodeId)
      .first<{ name: string }>();
    const response = new Response(
      createStoreZipStream(sources, (completed) => releasePins(env, row.id, completed)),
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${safeDownloadName(root?.name ?? "download")}"`,
          "Content-Length": String(row.outputSize),
          "Content-Type": "application/zip",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
    return await attachBudgetLease(response, lease);
  } catch (error) {
    await lease.settle().catch(() => undefined);
    await releasePins(env, row.id, false).catch(() => undefined);
    throw error;
  }
}

export async function serveUserZip(
  env: Env,
  user: AuthenticatedUser,
  zipId: string,
): Promise<Response> {
  const row = await loadManifest(env, zipId);
  if (row.issuerSessionId !== user.principal.sessionId) throw new Error("zip_not_found");
  if (row.shareId !== null) {
    const share = await findInternalShare(env, user.principal.userId, row.rootNodeId, "download");
    if (share?.id !== row.shareId || share.version !== row.shareVersion)
      throw new Error("zip_not_found");
  } else if (row.ownerId !== user.principal.userId) {
    throw new Error("zip_not_found");
  }
  return serveManifest(env, row);
}

export async function serveShareZip(
  env: Env,
  authentication: AuthenticatedShare,
  zipId: string,
): Promise<Response> {
  const row = await loadManifest(env, zipId);
  if (
    row.issuerSessionId !== authentication.sessionId ||
    row.shareId !== authentication.share.id ||
    row.shareVersion !== authentication.share.version
  ) {
    throw new Error("zip_not_found");
  }
  return serveManifest(env, row);
}

export async function reapExpiredZipManifests(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM zip_manifests WHERE expires_at<=?1 AND completed_at IS NULL AND canceled_at IS NULL LIMIT 100",
  )
    .bind(now)
    .all<{ id: string }>();
  for (const row of rows.results) await releasePins(env, row.id, false, now);
  return rows.results.length;
}
