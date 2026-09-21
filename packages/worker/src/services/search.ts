import type { NodeSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import { escapeLike, ftsBigramQuery, normalizeSearchText } from "../search/normalize.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { getOwnerWorkspace } from "./nodes.js";

export interface SearchResult {
  items: NodeSummary[];
  truncated: boolean;
}

interface SearchRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  current_blob_id: string | null;
  size: number | null;
  mime_sniffed: string | null;
  updated_at: number;
}

export async function searchNodes(
  env: Env,
  userId: string,
  scopeRootId: string,
  query: string,
  limit = 100,
): Promise<SearchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("Search limit is invalid");
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0 || new TextEncoder().encode(normalized).length > 50) {
    throw new RangeError("Search query is invalid");
  }
  const workspace = await getOwnerWorkspace(env, userId);
  if (!(await isEffectiveLive(env, scopeRootId, workspace.rootId)))
    throw new Error("node_not_found");
  const scopeCount = await env.DB.prepare(
    "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND scope.depth<64 LIMIT 10001) SELECT COUNT(*) count FROM scope",
  )
    .bind(scopeRootId, userId)
    .first<{ count: number }>();
  const pattern = `%${escapeLike(normalized)}%`;
  let rows: D1Result<SearchRow>;
  if (Array.from(normalized).length === 1) {
    rows = await env.DB.prepare(
      "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND scope.depth<64 LIMIT 10000) SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM scope JOIN nodes n ON n.id=scope.id JOIN search_index si ON si.node_id=n.id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.kind<>'root' AND n.deleted_at IS NULL AND si.revision=n.revision AND si.text_norm LIKE ?3 ESCAPE '\\' ORDER BY n.name_ci,n.id LIMIT ?4",
    )
      .bind(scopeRootId, userId, pattern, limit + 1)
      .all<SearchRow>();
  } else {
    rows = await env.DB.prepare(
      "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND scope.depth<64 LIMIT 10000),hits AS (SELECT si.node_id,bm25(search_fts) rank FROM search_fts JOIN search_index si ON si.rowid=search_fts.rowid WHERE search_fts MATCH ?3 AND si.space_id=?4 LIMIT 10000) SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM hits JOIN scope ON scope.id=hits.node_id JOIN nodes n ON n.id=hits.node_id JOIN search_index si ON si.node_id=n.id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.deleted_at IS NULL AND n.owner_id=?2 AND si.revision=n.revision AND si.text_norm LIKE ?5 ESCAPE '\\' ORDER BY hits.rank,n.id LIMIT ?6",
    )
      .bind(scopeRootId, userId, ftsBigramQuery(normalized), workspace.spaceId, pattern, limit + 1)
      .all<SearchRow>();
  }
  return {
    items: rows.results.slice(0, limit).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      kind: row.kind,
      revision: row.revision,
      blobId: row.current_blob_id,
      size: row.size,
      mime: row.mime_sniffed,
      updatedAt: row.updated_at,
    })),
    truncated: (scopeCount?.count ?? 0) >= 10_000 || rows.results.length > limit,
  };
}
