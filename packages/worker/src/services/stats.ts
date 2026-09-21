import type { NodeSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import { getOwnerWorkspace } from "./nodes.js";

export interface AccountStats {
  quotaBytes: number;
  usedBytes: number;
  physicalBytes: number;
  reservedBytes: number;
  files: number;
  folders: number;
  logicalBytes: number;
  truncated: boolean;
}

export async function getAccountStats(env: Env, userId: string): Promise<AccountStats> {
  const workspace = await getOwnerWorkspace(env, userId);
  const quota = await env.DB.prepare(
    "SELECT quota_bytes quotaBytes,used_bytes usedBytes,physical_bytes physicalBytes,reserved_bytes reservedBytes FROM users WHERE id=?1 AND disabled_at IS NULL",
  )
    .bind(userId)
    .first<{
      quotaBytes: number;
      usedBytes: number;
      physicalBytes: number;
      reservedBytes: number;
    }>();
  if (quota === null) throw new Error("user_not_found");
  const aggregate = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND sub.depth<64 LIMIT 10001) SELECT COUNT(*) total,SUM(n.kind='file') files,SUM(n.kind='folder') folders,COALESCE(SUM(CASE WHEN n.kind='file' THEN b.size ELSE 0 END),0) logicalBytes FROM sub JOIN nodes n ON n.id=sub.id LEFT JOIN blobs b ON b.id=n.current_blob_id",
  )
    .bind(workspace.rootId, userId)
    .first<{ total: number; files: number; folders: number; logicalBytes: number }>();
  return {
    ...quota,
    files: aggregate?.files ?? 0,
    folders: aggregate?.folders ?? 0,
    logicalBytes: aggregate?.logicalBytes ?? 0,
    truncated: (aggregate?.total ?? 0) >= 10_000,
  };
}

function mapNode(row: {
  id: string;
  parent_id: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  current_blob_id: string | null;
  size: number | null;
  mime_sniffed: string | null;
  updated_at: number;
}): NodeSummary {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    revision: row.revision,
    blobId: row.current_blob_id,
    size: row.size,
    mime: row.mime_sniffed,
    updatedAt: row.updated_at,
  };
}

export async function listRecent(env: Env, userId: string): Promise<NodeSummary[]> {
  const workspace = await getOwnerWorkspace(env, userId);
  const rows = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND sub.depth<64 LIMIT 10000) SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM sub JOIN nodes n ON n.id=sub.id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.kind<>'root' ORDER BY n.updated_at DESC,n.id LIMIT 200",
  )
    .bind(workspace.rootId, userId)
    .all<Parameters<typeof mapNode>[0]>();
  return rows.results.map(mapNode);
}

export async function listStarred(env: Env, userId: string): Promise<NodeSummary[]> {
  const workspace = await getOwnerWorkspace(env, userId);
  const rows = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND sub.depth<64 LIMIT 10000) SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM node_stars star JOIN sub ON sub.id=star.node_id JOIN nodes n ON n.id=star.node_id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE star.user_id=?2 AND n.deleted_at IS NULL ORDER BY star.created_at DESC,n.id LIMIT 200",
  )
    .bind(workspace.rootId, userId)
    .all<Parameters<typeof mapNode>[0]>();
  return rows.results.map(mapNode);
}

export async function setStar(
  env: Env,
  userId: string,
  sessionId: string,
  nodeId: string,
  starred: boolean,
): Promise<void> {
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.revoked_at IS NULL AND s.expires_at>?3 AND u.disabled_at IS NULL)",
    ).bind(sessionId, userId, now),
  ];
  if (starred) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO node_stars(user_id,node_id,created_at) SELECT ?1,id,?2 FROM nodes WHERE id=?3 AND owner_id=?1 AND deleted_at IS NULL",
      ).bind(userId, now, nodeId),
    );
  } else {
    statements.push(
      env.DB.prepare("DELETE FROM node_stars WHERE user_id=?1 AND node_id=?2").bind(userId, nodeId),
    );
  }
  await env.DB.batch(statements);
}
