import { nodeEventAuthority, readOutboxEvent } from "../jobs/outboxAuthority";
import {
  IMAGE_OUTPUT_BYTES,
  IMAGE_TRANSFORM_GENERATOR,
  IMAGE_VARIANTS,
  type ImageVariant,
} from "../media/images/transform";
import { assertExists, primary, type SqlStatement } from "./primary";

export interface ImageTransformRequest {
  id: string;
  epoch: number;
  ownerId: string;
  blobId: string;
  outboxId: string;
  claimToken: string;
  variant: ImageVariant;
  generator: typeof IMAGE_TRANSFORM_GENERATOR;
  deadline: number;
  expiresAt: number;
  source: {
    nodeId: string;
    parentId: string;
    key: string;
    etag: string;
    size: number;
    /** Fixed output geometry from the inspected source; these are transformation parameters. */
    width: number;
    height: number;
  };
}
export interface ImageTransformGrant extends ImageTransformRequest {
  token: string;
  startedAt: number;
}
export interface ImageTransformReceipt {
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}
export type ImageTransformTerminal = "succeeded" | "not_started";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateImageTransform(r: ImageTransformRequest) {
  if (
    !r ||
    !UUID.test(r.id) ||
    !UUID.test(r.claimToken) ||
    !ID.test(r.ownerId) ||
    !ID.test(r.blobId) ||
    !ID.test(r.outboxId) ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch < 1 ||
    !Object.hasOwn(IMAGE_VARIANTS, r.variant) ||
    r.generator !== IMAGE_TRANSFORM_GENERATOR ||
    !Number.isSafeInteger(r.deadline) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt < r.deadline ||
    !r.source ||
    !ID.test(r.source.nodeId) ||
    !ID.test(r.source.parentId) ||
    r.source.key !== `u/${r.ownerId}/b/${r.blobId}` ||
    typeof r.source.etag !== "string" ||
    !r.source.etag ||
    r.source.etag.length > 256 ||
    !Number.isSafeInteger(r.source.size) ||
    r.source.size < 1 ||
    r.source.size > 20_000_000 ||
    ![r.source.width, r.source.height].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= IMAGE_VARIANTS[r.variant],
    )
  )
    throw new Error("invalid_image_transform");
}
export function validateImageTransformGrant(g: ImageTransformGrant) {
  validateImageTransform(g);
  if (
    !UUID.test(g.token) ||
    !Number.isSafeInteger(g.startedAt) ||
    g.startedAt < 0 ||
    g.deadline <= g.startedAt ||
    g.deadline > g.startedAt + 5000 ||
    g.expiresAt > g.startedAt + 25000
  )
    throw new Error("invalid_image_transform");
}
export function imageOutputJson(g: ImageTransformGrant, output: ImageTransformReceipt | null) {
  if (output === null) return null;
  if (
    !output ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > IMAGE_OUTPUT_BYTES ||
    output.width !== g.source.width ||
    output.height !== g.source.height ||
    !/^[a-f0-9]{64}$/.test(output.sha256)
  )
    throw new Error("invalid_image_transform_output");
  return JSON.stringify({
    bytes: output.bytes,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
  });
}
export const IMAGE_TRANSFORM_IDENTITY = `id=? AND token=? AND epoch=? AND owner_id=? AND blob_id=?
 AND outbox_id=? AND variant=? AND generator_version=? AND claim_token=? AND source_json=?
 AND started_at=? AND dispatch_before=? AND expires_at=?`;
export function imageTransformValues(g: ImageTransformGrant) {
  const s = g.source;
  return [
    g.id,
    g.token,
    g.epoch,
    g.ownerId,
    g.blobId,
    g.outboxId,
    g.variant,
    g.generator,
    g.claimToken,
    JSON.stringify({
      nodeId: s.nodeId,
      parentId: s.parentId,
      key: s.key,
      etag: s.etag,
      size: s.size,
      width: s.width,
      height: s.height,
    }),
    g.startedAt,
    g.deadline,
    g.expiresAt,
  ];
}
export function insertImageTransform(
  g: ImageTransformGrant,
  state: "pending" | ImageTransformTerminal,
  output: string | null,
): SqlStatement {
  return {
    sql: `INSERT INTO image_transform_attempts(id,token,epoch,owner_id,blob_id,outbox_id,variant,generator_version,claim_token,source_json,started_at,dispatch_before,expires_at,state,finished_at,output_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,${state === "pending" ? "NULL" : "MAX(?,strftime('%s','now')*1000)"},?)`,
    values: [
      ...imageTransformValues(g),
      state,
      ...(state === "pending" ? [] : [g.startedAt]),
      output,
    ],
  };
}
export async function confirmImageTransform(
  db: D1Database,
  g: ImageTransformGrant,
  state: ImageTransformTerminal,
  output: string | null,
) {
  return (
    (await primary(db)
      .prepare(
        `SELECT 1 FROM image_transform_attempts WHERE ${IMAGE_TRANSFORM_IDENTITY} AND state=? AND output_json IS ?`,
      )
      .bind(...imageTransformValues(g), state, output)
      .first()) !== null
  );
}
export async function imageTransformAuthority(db: D1Database, g: ImageTransformRequest) {
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
    throw new Error("image_transform_unauthorized");
  const authority = await nodeEventAuthority(db, row);
  if (!authority) throw new Error("image_transform_unauthorized");
  return [
    ...authority,
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
export function imageGrantFromRow(row: Record<string, unknown>): ImageTransformGrant {
  const g = {
    id: row.id,
    token: row.token,
    epoch: row.epoch,
    ownerId: row.owner_id,
    blobId: row.blob_id,
    outboxId: row.outbox_id,
    claimToken: row.claim_token,
    variant: row.variant,
    generator: row.generator_version,
    deadline: row.dispatch_before,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    source: JSON.parse(row.source_json as string),
  } as ImageTransformGrant;
  validateImageTransformGrant(g);
  return g;
}
