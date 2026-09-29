import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { assertExists, primary } from "../db/primary";
import { IMAGE_METADATA_GENERATOR } from "../media/images/inspect";
import { IMAGE_TRANSFORM_GENERATOR } from "../media/images/transform";
import { digestJson } from "./operations";
import { type EventRow, savedPrincipal } from "./outboxAuthority";

export interface ImageRequestOperands {
  nodeId: string;
  parentId: string;
  blobId: string;
  variant: "lg";
  generator: string;
}
export const imageRequestKey = (blobId: string) =>
  digestJson([blobId, "lg", IMAGE_TRANSFORM_GENERATOR]).then((hash) => "lg_" + hash);

export function imageRequestOperands(row: EventRow): ImageRequestOperands {
  const o = JSON.parse(row.operands_json) as ImageRequestOperands;
  if (
    !o ||
    Object.keys(o).sort().join(",") !== "blobId,generator,nodeId,parentId,variant" ||
    ![o.nodeId, o.parentId, o.blobId].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    o.variant !== "lg" ||
    o.generator !== IMAGE_TRANSFORM_GENERATOR
  )
    throw new Error("invalid_image_request");
  return o;
}

export const IMAGE_REQUEST_SOURCE = `SELECT n.id,n.parent_id AS parent,n.current_blob_id AS blob,
 b.r2_key AS key,b.size,s.r2_etag AS etag FROM nodes n
 JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
 JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
 JOIN node_media m ON m.node_id=n.id AND m.blob_id=b.id AND m.generator_version=?5
 WHERE n.id=?1 AND n.parent_id=?2 AND n.current_blob_id=?3 AND n.owner_id=?4
 AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL
 AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
 AND b.mime_sniffed IN ('image/jpeg','image/png','image/webp','image/avif')
 AND m.width>0 AND m.height>0 AND s.r2_etag IS NOT NULL`;

/** Saved reader authority is independent of the old uploader's credential. */
export async function imageRequestAuthority(db: D1Database, row: EventRow) {
  try {
    if (
      row.kind !== "image.requested" ||
      row.op_kind !== "thumbnail.request" ||
      row.op_state !== "committed" ||
      row.destination_space_id !== null ||
      row.destination_share_id !== null ||
      row.destination_share_version !== null
    )
      return null;
    const o = imageRequestOperands(row),
      principal = savedPrincipal(row);
    if (
      !principal ||
      !["user", "link_share"].includes(principal.kind) ||
      row.payload_ref !== (await imageRequestKey(o.blobId))
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
    const source = assertExists(IMAGE_REQUEST_SOURCE, [
      o.nodeId,
      o.parentId,
      o.blobId,
      row.owner_id,
      IMAGE_METADATA_GENERATOR,
    ]);
    if (
      !(await primary(db)
        .prepare(IMAGE_REQUEST_SOURCE)
        .bind(...source.values!)
        .first())
    )
      return null;
    return [
      authorizationAssertion(proof),
      source,
      assertExists(
        `SELECT 1 FROM operations op JOIN operation_steps step ON step.op_id=op.op_id
       WHERE op.op_id=? AND op.kind='thumbnail.request' AND op.state='committed' AND op.epoch=?
       AND op.operands_json=? AND op.result_json=? AND step.kind='image_request' AND step.affected_id=?`,
        [row.op_id, row.epoch, row.operands_json, row.result_json, row.payload_ref],
      ),
    ];
  } catch {
    return null;
  }
}
