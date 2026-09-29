import { nodeEventAuthority, readOutboxEvent } from "../jobs/outboxAuthority";
import {
  ARCHIVE_GENERATOR,
  type ArchiveIndexOutput,
  type ArchiveOriginal,
} from "../media/archive/codec";
import { ARCHIVE_LIMITS } from "../media/archive/format";
import { assertExists } from "./primary";

export interface ArchiveDerivativeGrant {
  id: string;
  ownerId: string;
  blobId: string;
  epoch: number;
  outboxId: string;
  claimToken: string;
  expiresAt: number;
  source: { nodeId: string; parentId: string; key: string; size: number; etag: string };
}
export interface ArchiveDerivativeReceipt {
  bytes: number;
  sha256: string;
  entryCount: number;
  pageCount: number;
}
export const archiveDerivativeKey = (g: ArchiveDerivativeGrant) =>
  `u/${g.ownerId}/d/${g.blobId}/${ARCHIVE_GENERATOR}/index/${g.id}`;
export const archiveOriginalFromGrant = (g: ArchiveDerivativeGrant): ArchiveOriginal => ({
  ownerId: g.ownerId,
  blobId: g.blobId,
  key: g.source.key,
  size: g.source.size,
  etag: g.source.etag,
});

export function validateArchiveGrant(g: ArchiveDerivativeGrant) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    id = /^[A-Za-z0-9_-]{1,128}$/;
  if (
    !g ||
    !uuid.test(g.id) ||
    !uuid.test(g.claimToken) ||
    ![g.ownerId, g.blobId, g.outboxId].every((v) => typeof v === "string" && id.test(v)) ||
    !Number.isSafeInteger(g.epoch) ||
    g.epoch < 1 ||
    !Number.isSafeInteger(g.expiresAt) ||
    g.expiresAt < 0 ||
    !g.source ||
    ![g.source.nodeId, g.source.parentId].every((v) => typeof v === "string" && id.test(v)) ||
    g.source.key !== `u/${g.ownerId}/b/${g.blobId}` ||
    !Number.isSafeInteger(g.source.size) ||
    g.source.size < 22 ||
    typeof g.source.etag !== "string" ||
    !g.source.etag ||
    g.source.etag.length > 256 ||
    Object.keys(g.source).sort().join(",") !== "etag,key,nodeId,parentId,size"
  )
    throw new Error("invalid_archive_derivative");
}
export function archiveOutputReceipt(output: ArchiveIndexOutput): ArchiveDerivativeReceipt {
  return {
    bytes: output.bytes.length,
    sha256: output.sha256,
    entryCount: output.entryCount,
    pageCount: output.pageCount,
  };
}
export function archiveOutputJson(output: ArchiveDerivativeReceipt): string {
  if (
    !output ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > ARCHIVE_LIMITS.indexBytes ||
    !/^[a-f0-9]{64}$/.test(output.sha256) ||
    ![output.entryCount, output.pageCount].every(
      (v) => Number.isSafeInteger(v) && v >= 0 && v <= ARCHIVE_LIMITS.entries,
    ) ||
    output.pageCount > output.entryCount
  )
    throw new Error("invalid_archive_derivative_output");
  return JSON.stringify({
    bytes: output.bytes,
    sha256: output.sha256,
    entryCount: output.entryCount,
    pageCount: output.pageCount,
  });
}
export function archiveGrantFromRow(row: Record<string, unknown>): ArchiveDerivativeGrant {
  const g = {
    id: row.id,
    ownerId: row.owner_id,
    blobId: row.source_blob_id,
    epoch: row.epoch,
    outboxId: row.outbox_id,
    claimToken: row.claim_token,
    expiresAt: row.expires_at,
    source: JSON.parse(row.source_json as string),
  } as ArchiveDerivativeGrant;
  validateArchiveGrant(g);
  return g;
}
export function archiveGrantJson(g: ArchiveDerivativeGrant): string {
  validateArchiveGrant(g);
  return JSON.stringify({
    id: g.id,
    ownerId: g.ownerId,
    blobId: g.blobId,
    epoch: g.epoch,
    outboxId: g.outboxId,
    claimToken: g.claimToken,
    expiresAt: g.expiresAt,
    source: {
      nodeId: g.source.nodeId,
      parentId: g.source.parentId,
      key: g.source.key,
      size: g.source.size,
      etag: g.source.etag,
    },
  });
}

/** A write grant alone does not exclude hidden ancestors from media indexing. */
export function archiveVisibleSource(nodeId: string, ownerId: string) {
  return assertExists(
    `WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,hidden,deleted_at,depth,path) AS (
      SELECT id,parent_id,space_id,owner_id,kind,hidden,deleted_at,0,'/'||id||'/'
      FROM nodes WHERE id=? AND owner_id=?
      UNION ALL
      SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.hidden,n.deleted_at,a.depth+1,a.path||n.id||'/'
      FROM nodes n JOIN a ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=a.space_id AND n.owner_id=a.owner_id
        AND instr(a.path,'/'||n.id||'/')=0
    ) SELECT COUNT(*) FROM a JOIN spaces s ON s.id=a.space_id AND s.owner_id=a.owner_id
      HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.hidden=0)=1 AND MIN(a.deleted_at IS NULL)=1
        AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=s.root_node_id)=1`,
    [nodeId, ownerId],
  );
}

/** Original upload actor and blob step remain authoritative throughout background indexing. */
export async function archiveDerivativeAuthority(db: D1Database, g: ArchiveDerivativeGrant) {
  validateArchiveGrant(g);
  const row = await readOutboxEvent(db, g.outboxId);
  if (
    !row ||
    !["dav.put", "upload.complete"].includes(row.op_kind) ||
    !["node.created", "node.updated"].includes(row.kind) ||
    row.owner_id !== g.ownerId ||
    row.payload_ref !== g.source.nodeId ||
    row.epoch !== g.epoch ||
    JSON.parse(row.operands_json).parentId !== g.source.parentId
  )
    throw new Error("archive_derivative_unauthorized");
  const authority = await nodeEventAuthority(db, row);
  if (!authority) throw new Error("archive_derivative_unauthorized");
  return [
    ...authority,
    archiveVisibleSource(g.source.nodeId, g.ownerId),
    assertExists(
      `SELECT 1 FROM outbox e JOIN nodes n ON n.id=e.payload_ref
    JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
    JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
    JOIN operation_steps p ON p.op_id=e.op_id AND p.kind='blob' AND p.affected_id=b.id
    JOIN control c ON c.singleton=1 AND c.epoch=e.epoch AND c.maintenance=0
    WHERE e.outbox_id=? AND e.claim_token=? AND e.claim_expires_at>=? AND e.epoch=?
    AND e.state IN ('dispatching','sent') AND n.id=? AND n.parent_id=? AND n.owner_id=?
    AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL
    AND b.id=? AND b.r2_key=? AND b.size=? AND s.r2_etag=? AND b.state IN ('committed','gc_candidate')`,
      [
        g.outboxId,
        g.claimToken,
        g.expiresAt,
        g.epoch,
        g.source.nodeId,
        g.source.parentId,
        g.ownerId,
        g.blobId,
        g.source.key,
        g.source.size,
        g.source.etag,
      ],
    ),
  ];
}
