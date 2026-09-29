import { MEDIA_EXTRACTION_GENERATOR } from "../../../shared/src/mediaExtraction";
import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { assertExists, primary } from "../db/primary";
import { digestJson } from "./operations";
import { type EventRow, savedPrincipal } from "./outboxAuthority";
export interface MediaRequestOperands {
  nodeId: string;
  parentId: string;
  blobId: string;
  generator: string;
}
export const mediaRequestKey = (nodeId: string, blobId: string) =>
  digestJson([nodeId, blobId, MEDIA_EXTRACTION_GENERATOR]).then((hash) => "media_" + hash);
export function mediaRequestOperands(row: EventRow): MediaRequestOperands {
  const o = JSON.parse(row.operands_json) as MediaRequestOperands;
  if (
    !o ||
    Object.keys(o).sort().join(",") !== "blobId,generator,nodeId,parentId" ||
    ![o.nodeId, o.parentId, o.blobId].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    o.generator !== MEDIA_EXTRACTION_GENERATOR
  )
    throw new Error("invalid_media_request");
  return o;
}
export const MEDIA_REQUEST_SOURCE = `SELECT n.id,n.name,n.revision,n.parent_id AS parent,n.current_blob_id AS blob,
 b.r2_key AS key,b.size,s.r2_etag AS etag FROM nodes n
 JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
 JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
 WHERE n.id=?1 AND n.parent_id=?2 AND n.current_blob_id=?3 AND n.owner_id=?4
 AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL
 AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
 AND s.r2_etag IS NOT NULL`;
/** Saved reader authority is independent of the old uploader's credential. */
export async function mediaRequestAuthority(db: D1Database, row: EventRow) {
  try {
    if (
      row.kind !== "media.requested" ||
      row.op_kind !== "media.extract" ||
      row.op_state !== "committed" ||
      row.destination_space_id !== null ||
      row.destination_share_id !== null ||
      row.destination_share_version !== null
    )
      return null;
    const o = mediaRequestOperands(row),
      principal = savedPrincipal(row);
    if (
      !principal ||
      !["user", "link_share"].includes(principal.kind) ||
      row.payload_ref !== (await mediaRequestKey(o.nodeId, o.blobId))
    )
      return null;
    const result = JSON.parse(row.result_json ?? "null");
    if (
      !result ||
      Object.keys(result).sort().join(",") !== "nodeId,status" ||
      result.status !== 202 ||
      result.nodeId !== o.nodeId
    )
      return null;
    const proof = await authorizeNode(db, principal, {
      operation: "gallery.read",
      nodeId: o.nodeId,
      spaceId: row.space_id,
    });
    if (
      proof.operation !== "gallery.read" ||
      proof.node.owner_id !== row.owner_id ||
      proof.node.current_blob_id !== o.blobId ||
      proof.node.parent_id !== o.parentId ||
      (principal.kind === "user" && !principal.selected_share && principal.user_id !== row.owner_id)
    )
      return null;
    const source = assertExists(MEDIA_REQUEST_SOURCE, [
      o.nodeId,
      o.parentId,
      o.blobId,
      row.owner_id,
    ]);
    if (
      !(await primary(db)
        .prepare(MEDIA_REQUEST_SOURCE)
        .bind(...source.values!)
        .first())
    )
      return null;
    return [
      authorizationAssertion(proof),
      source,
      assertExists(
        `SELECT 1 FROM operations op JOIN operation_steps step ON step.op_id=op.op_id
       WHERE op.op_id=? AND op.kind='media.extract' AND op.state='committed' AND op.epoch=?
       AND op.operands_json=? AND op.result_json=? AND step.kind='media_request' AND step.affected_id=?`,
        [row.op_id, row.epoch, row.operands_json, row.result_json, row.payload_ref],
      ),
    ];
  } catch {
    return null;
  }
}
