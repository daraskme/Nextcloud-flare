import { assertExists, primary, type SqlStatement } from "../db/primary";

// Current blob markers, including files under a selected folder, are the authority. The
// bounded tree is also checked inside the write batch so a concurrent adoption cannot race.
const ENCRYPTED_SUBTREE = `WITH RECURSIVE tree(id,depth,path) AS (
  SELECT id,0,'/'||id||'/' FROM nodes
    WHERE id=? AND space_id=? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id,t.depth+1,t.path||n.id||'/' FROM nodes n JOIN tree t ON n.parent_id=t.id
    WHERE t.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
      AND instr(t.path,'/'||n.id||'/')=0
) SELECT 1 FROM tree t JOIN nodes n ON n.id=t.id
  JOIN blob_encryption be ON be.blob_id=n.current_blob_id AND be.owner_id=n.owner_id
  LIMIT 1`;

export async function assertNoEncryptedSubtree(
  db: D1Database,
  nodeId: string,
  spaceId: string,
): Promise<void> {
  const found = await primary(db).prepare(ENCRYPTED_SUBTREE).bind(nodeId, spaceId, spaceId).first();
  if (found) throw new Error("encrypted_operation_forbidden");
}

export function unencryptedSubtreeAssertion(nodeId: string, spaceId: string): SqlStatement {
  return assertExists(`SELECT 1 WHERE NOT EXISTS (${ENCRYPTED_SUBTREE})`, [
    nodeId,
    spaceId,
    spaceId,
  ]);
}

export async function assertUnencryptedBlob(db: D1Database, blobId: string): Promise<void> {
  if (
    await primary(db).prepare("SELECT 1 FROM blob_encryption WHERE blob_id=?").bind(blobId).first()
  )
    throw new Error("encrypted_operation_forbidden");
}

export function unencryptedBlobAssertion(blobId: string): SqlStatement {
  return assertExists("SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM blob_encryption WHERE blob_id=?)", [
    blobId,
  ]);
}
