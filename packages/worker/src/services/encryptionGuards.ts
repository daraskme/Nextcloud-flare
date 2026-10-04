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

// A share can be created while an encrypted child is in the trash. Check the exact
// trash membership, including deleted nodes, and the destination's complete ancestry.
// The same predicate runs in the publishing batch to fence concurrent share changes.
const PRIVATE_ENCRYPTED_RESTORE = `WITH RECURSIVE ancestry(id,parent_id,kind,depth,path) AS (
  SELECT id,parent_id,kind,0,'/'||id||'/' FROM nodes
    WHERE id=? AND space_id=? AND deleted_at IS NULL
  UNION ALL SELECT n.id,n.parent_id,n.kind,a.depth+1,a.path||n.id||'/'
    FROM nodes n JOIN ancestry a ON n.id=a.parent_id
    WHERE n.space_id=? AND n.deleted_at IS NULL AND a.depth<128
      AND instr(a.path,'/'||n.id||'/')=0
), members AS (
  SELECT n.id,n.current_blob_id,n.owner_id FROM trash_members tm JOIN nodes n ON n.id=tm.node_id
    WHERE tm.trash_op_id=? AND n.space_id=? AND n.deleted_op_id=tm.trash_op_id
      AND n.deleted_at IS NOT NULL
) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM members m JOIN blob_encryption be
    ON be.blob_id=m.current_blob_id AND be.owner_id=m.owner_id
) OR (
  EXISTS(SELECT 1 FROM ancestry a JOIN spaces s ON s.root_node_id=a.id
    WHERE s.id=? AND a.parent_id IS NULL AND a.kind='root')
  AND NOT EXISTS(SELECT 1 FROM shares sh
    WHERE (sh.root_node_id IN (SELECT id FROM ancestry) OR sh.root_node_id IN (SELECT id FROM members))
      AND sh.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000))
)`;

function restoreValues(trashOpId: string, parentId: string, spaceId: string) {
  return [parentId, spaceId, spaceId, trashOpId, spaceId, spaceId];
}

export async function assertPrivateEncryptedRestore(
  db: D1Database,
  trashOpId: string,
  parentId: string,
  spaceId: string,
): Promise<void> {
  const allowed = await primary(db)
    .prepare(PRIVATE_ENCRYPTED_RESTORE)
    .bind(...restoreValues(trashOpId, parentId, spaceId))
    .first();
  if (!allowed) throw new Error("encrypted_operation_forbidden");
}

export function privateEncryptedRestoreAssertion(
  trashOpId: string,
  parentId: string,
  spaceId: string,
): SqlStatement {
  return assertExists(PRIVATE_ENCRYPTED_RESTORE, restoreValues(trashOpId, parentId, spaceId));
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
