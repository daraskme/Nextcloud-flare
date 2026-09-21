import type { Env } from "../env.js";

export async function listNodeVersions(
  env: Env,
  userId: string,
  nodeId: string,
): Promise<{ id: string; blobId: string; size: number; createdAt: number }[]> {
  const rows = await env.DB.prepare(
    "SELECT v.id,v.blob_id blobId,b.size,v.created_at createdAt FROM node_versions v JOIN nodes n ON n.id=v.node_id JOIN blobs b ON b.id=v.blob_id WHERE v.node_id=?1 AND n.owner_id=?2 ORDER BY v.created_at DESC,v.id DESC LIMIT 200",
  )
    .bind(nodeId, userId)
    .all<{ id: string; blobId: string; size: number; createdAt: number }>();
  return rows.results;
}
