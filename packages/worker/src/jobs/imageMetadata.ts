import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  IMAGE_METADATA_GENERATOR,
  type ImageMetadata,
  inspectImage,
} from "../media/images/inspect";
import { type ImageReadBudget, imageObjectSource } from "../media/images/r2Source";
import type { EventRow } from "./outboxAuthority";

export interface ImageNode {
  id: string;
  blob: string;
  parent: string;
  key: string;
  size: number;
  etag: string | null;
}
export interface PreparedImageMetadata {
  statements: readonly SqlStatement[];
  source?: { node: ImageNode & { etag: string }; image: ImageMetadata; guard: () => Promise<void> };
}
const SOURCE = `SELECT n.id,n.current_blob_id AS blob,n.parent_id AS parent,b.r2_key AS key,b.size,s.r2_etag AS etag
  FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
  LEFT JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
  JOIN operation_steps step ON step.affected_id=b.id AND step.kind='blob'
  WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND step.op_id=? AND n.parent_id=?
    AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL
    AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id`;

/** Original file writes feed metadata through the same outbox claim and terminal transaction. */
export async function imageMetadataStatements(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "BLOBS">>,
  event: EventRow,
  claim: SqlStatement,
  authority: readonly SqlStatement[],
  deadline: number,
  budget: ImageReadBudget,
): Promise<PreparedImageMetadata> {
  if (
    !["upload.complete", "dav.put"].includes(event.op_kind) ||
    !["node.created", "node.updated"].includes(event.kind)
  )
    return { statements: [] };
  const values = [
    event.payload_ref,
    event.space_id,
    event.owner_id,
    event.op_id,
    JSON.parse(event.operands_json).parentId,
  ];
  const node = await primary(env.DB)
    .prepare(SOURCE)
    .bind(...values)
    .first<ImageNode>();
  // An event superseded by another content write must never inspect or adopt that write's blob.
  if (!node) return { statements: [] };
  if (!env.BLOBS || !node.etag) throw new Error("image_source_unavailable");
  const hold = assertExists(
    SOURCE +
      " AND n.current_blob_id=? AND n.parent_id=? AND b.r2_key=? AND b.size=? AND s.r2_etag=?",
    [...values, node.blob, node.parent, node.key, node.size, node.etag],
  );
  const guard = async () => {
    await atomicBatch(env.DB, [...authority, claim, hold]);
  };
  await guard();
  const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const image = await inspectImage(
    imageObjectSource(
      env.BLOBS,
      { key: node.key, size: node.size, etag: node.etag },
      signal,
      guard,
      budget,
    ),
  );
  signal.throwIfAborted();
  // Even the no-image result belongs to this exact current blob and source authorization.
  const result: SqlStatement[] = [
    hold,
    { sql: "DELETE FROM node_media WHERE node_id=?", values: [node.id] },
  ];
  if (image)
    result.push(
      {
        sql: `INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,orientation,camera_make,camera_model)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        values: [
          node.id,
          node.blob,
          IMAGE_METADATA_GENERATOR,
          image.width,
          image.height,
          image.takenAt ?? null,
          image.orientation ?? 1,
          image.cameraMake ?? null,
          image.cameraModel ?? null,
        ],
      },
      {
        sql: "UPDATE blobs SET mime_sniffed=? WHERE id=? AND owner_id=?",
        values: [image.mime, node.blob, event.owner_id],
      },
    );
  return {
    statements: result,
    ...(image ? { source: { node: { ...node, etag: node.etag }, image, guard } } : {}),
  };
}
