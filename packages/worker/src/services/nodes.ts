import type { BreadcrumbItem, ChildrenPage, NodeSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import { isEffectiveLive } from "./effectiveLive.js";

interface NodeRow {
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

function summary(row: NodeRow): NodeSummary {
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

async function ownerRoot(env: Env, userId: string): Promise<{ rootId: string; spaceId: string }> {
  const row = await env.DB.prepare(
    "SELECT s.root_node_id rootId,s.id spaceId FROM spaces s JOIN users u ON u.id=s.owner_id WHERE s.owner_id=?1 AND u.disabled_at IS NULL",
  )
    .bind(userId)
    .first<{ rootId: string; spaceId: string }>();
  if (row === null) {
    throw new Error("space_not_found");
  }
  return row;
}

export async function getOwnedNode(env: Env, userId: string, nodeId: string): Promise<NodeSummary> {
  const root = await ownerRoot(env, userId);
  if (!(await isEffectiveLive(env, nodeId, root.rootId))) {
    throw new Error("node_not_found");
  }
  const row = await env.DB.prepare(
    "SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM nodes n LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL",
  )
    .bind(nodeId, userId)
    .first<NodeRow>();
  if (row === null) {
    throw new Error("node_not_found");
  }
  return summary(row);
}

export async function listOwnedChildren(
  env: Env,
  userId: string,
  parentId: string,
  afterName = "",
  afterId = "",
  limit = 200,
): Promise<ChildrenPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("Page size is invalid");
  }
  const root = await ownerRoot(env, userId);
  if (!(await isEffectiveLive(env, parentId, root.rootId))) {
    throw new Error("node_not_found");
  }
  const parent = await env.DB.prepare(
    "SELECT kind FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL",
  )
    .bind(parentId, userId)
    .first<{ kind: string }>();
  if (parent?.kind !== "root" && parent?.kind !== "folder") {
    throw new Error("not_a_folder");
  }
  const rows = await env.DB.prepare(
    "SELECT n.id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM nodes n INDEXED BY nodes_children_keyset LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id=?1 AND n.deleted_at IS NULL AND (n.name_ci>?2 OR (n.name_ci=?2 AND n.id>?3)) ORDER BY n.name_ci,n.id LIMIT ?4",
  )
    .bind(parentId, afterName, afterId, limit + 1)
    .all<NodeRow>();
  const items = rows.results.slice(0, limit).map(summary);
  const generation = await env.DB.prepare("SELECT tree_generation value FROM spaces WHERE id=?1")
    .bind(root.spaceId)
    .first<{ value: number }>();
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.results.length > limit && last !== undefined
        ? btoa(JSON.stringify({ name: last.name.normalize("NFC").toLowerCase(), id: last.id }))
        : null,
    treeGeneration: generation?.value ?? 0,
  };
}

export async function getOwnedPath(
  env: Env,
  userId: string,
  nodeId: string,
): Promise<BreadcrumbItem[]> {
  const root = await ownerRoot(env, userId);
  if (!(await isEffectiveLive(env, nodeId, root.rootId))) {
    throw new Error("node_not_found");
  }
  const rows = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,name,depth) AS (SELECT id,parent_id,name,0 FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL UNION ALL SELECT p.id,p.parent_id,p.name,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL) SELECT id,name FROM a ORDER BY depth DESC",
  )
    .bind(nodeId, userId)
    .all<{ id: string; name: string }>();
  if (rows.results[0]?.id !== root.rootId) {
    throw new Error("node_not_found");
  }
  return rows.results.map((item) => ({ id: item.id, name: item.name || "My Drive" }));
}

export async function getOwnerWorkspace(
  env: Env,
  userId: string,
): Promise<{ rootId: string; spaceId: string; treeGeneration: number }> {
  const root = await ownerRoot(env, userId);
  const row = await env.DB.prepare("SELECT tree_generation value FROM spaces WHERE id=?1")
    .bind(root.spaceId)
    .first<{ value: number }>();
  return { ...root, treeGeneration: row?.value ?? 0 };
}
