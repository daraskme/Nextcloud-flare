import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertExists, primary, type SqlStatement } from "../db/primary";
import { inspectVideoObject, VIDEO_METADATA_GENERATOR, type VideoMetadata } from "../media/video";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import type { MediaOutboxClaim } from "./media";

const CLOCK = "strftime('%s','now')*1000";

export type VideoJobEnv = SystemMutationSource & {
  readonly BLOBS: R2Bucket;
};

interface VideoSource {
  node_id: string;
  space_id: string;
  owner_id: string;
  blob_id: string;
  r2_key: string;
  size: number;
  r2_etag: string;
}

export type VideoProjectionResult = "completed" | "not-video" | "retry";

function outboxFence(claim: MediaOutboxClaim): SqlStatement {
  return assertExists(
    `SELECT 1 FROM outbox b JOIN operations o ON o.op_id=b.op_id
      JOIN operation_steps s ON s.op_id=o.op_id
      WHERE b.outbox_id=? AND b.claim_token=? AND b.claim_expires_at>${CLOCK}
      AND b.epoch=? AND b.state IN ('dispatching','sent')
      AND o.state='committed' AND o.epoch=b.epoch AND o.kind=?
      AND o.operands_json=? AND o.result_json=?
      AND s.kind='node' AND s.affected_id=b.payload_ref
      AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)`,
    [
      claim.outboxId,
      claim.outboxToken,
      claim.epoch,
      claim.operationKind,
      claim.operandsJson,
      claim.resultJson,
      claim.epoch,
    ],
  );
}

function sourceFence(source: VideoSource): SqlStatement {
  return assertExists(
    `SELECT 1 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage s ON s.blob_id=b.id
      WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.kind='file'
        AND n.deleted_at IS NULL AND n.current_blob_id=?
        AND b.owner_id=? AND b.r2_key=? AND b.size=? AND b.state IN ('committed','gc_candidate')
        AND s.bytes=? AND s.r2_etag=? AND s.removed_at IS NULL`,
    [
      source.node_id,
      source.space_id,
      source.owner_id,
      source.blob_id,
      source.owner_id,
      source.r2_key,
      source.size,
      source.size,
      source.r2_etag,
    ],
  );
}

async function source(db: D1Database, nodeId: string): Promise<VideoSource | null> {
  return primary(db)
    .prepare(`SELECT n.id AS node_id,n.space_id,n.owner_id,b.id AS blob_id,b.r2_key,b.size,
      s.r2_etag FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage s ON s.blob_id=b.id
      WHERE n.id=? AND n.kind='file' AND n.deleted_at IS NULL
        AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
        AND b.owner_id=n.owner_id AND s.bytes=b.size`)
    .bind(nodeId)
    .first<VideoSource>();
}

async function mutate(
  env: VideoJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: VideoSource,
  statements: readonly SqlStatement[],
  deadline: number,
): Promise<void> {
  const admission = await acquireSystemMutation(env, claim.ownerId, "media.project", deadline);
  await commitSystemMutation(env.DB, admission, claim.ownerId, [
    authorizationAssertion(authorized),
    outboxFence(claim),
    sourceFence(row),
    ...statements,
  ]);
}

function metadataStatement(row: VideoSource, metadata: VideoMetadata): SqlStatement {
  return {
    sql: `INSERT INTO node_media(
        node_id,blob_id,generator_version,width,height,duration_ms,container,video_codec,
        audio_codec,codec_profile,codec_level,codec_tier,bit_depth
      ) VALUES(?,?,?,?,?,? ,?,'av1',?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET
        blob_id=excluded.blob_id,generator_version=excluded.generator_version,
        projection_state='ready',error_code=NULL,
        width=excluded.width,height=excluded.height,duration_ms=excluded.duration_ms,
        taken_at=NULL,orientation=NULL,dominant_color=NULL,camera_make=NULL,camera_model=NULL,
        container=excluded.container,video_codec=excluded.video_codec,
        audio_codec=excluded.audio_codec,codec_profile=excluded.codec_profile,
        codec_level=excluded.codec_level,codec_tier=excluded.codec_tier,bit_depth=excluded.bit_depth`,
    values: [
      row.node_id,
      row.blob_id,
      VIDEO_METADATA_GENERATOR,
      metadata.width,
      metadata.height,
      metadata.durationMs,
      metadata.container,
      metadata.audio,
      metadata.configuration.profile,
      metadata.configuration.level,
      metadata.configuration.tier,
      metadata.configuration.bitDepth,
    ],
  };
}

/** Project bounded AV1 metadata while the saved outbox claim and source identity remain current. */
export async function processVideoOutbox(
  env: VideoJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  deadline: number,
): Promise<VideoProjectionResult> {
  if (Date.now() >= deadline) return "retry";
  if (authorized.operation !== "node.read") return "completed";
  const row = await source(env.DB, claim.nodeId);
  if (
    !row ||
    row.owner_id !== claim.ownerId ||
    row.space_id !== authorized.node.space_id ||
    row.r2_key !== `u/${row.owner_id}/b/${row.blob_id}`
  )
    return "completed";
  const inspection = await inspectVideoObject(
    env.BLOBS,
    { key: row.r2_key, size: row.size, r2Etag: row.r2_etag },
    deadline,
  );
  if (inspection.kind === "transient") return "retry";
  if (inspection.kind === "not-video") return "not-video";
  await mutate(
    env,
    claim,
    authorized,
    row,
    inspection.kind === "metadata"
      ? [
          metadataStatement(row, inspection.metadata),
          {
            sql: `UPDATE blobs SET mime_sniffed=? WHERE id=? AND owner_id=?
              AND state IN ('committed','gc_candidate')`,
            values: [`video/${inspection.metadata.container}`, row.blob_id, row.owner_id],
          },
          assertExists("SELECT 1 FROM blobs WHERE id=? AND mime_sniffed=?", [
            row.blob_id,
            `video/${inspection.metadata.container}`,
          ]),
        ]
      : [
          {
            sql: `INSERT INTO node_media(
              node_id,blob_id,generator_version,projection_state,error_code
            ) VALUES(?,?,?,'failed',?)
            ON CONFLICT(node_id) DO UPDATE SET
              blob_id=excluded.blob_id,generator_version=excluded.generator_version,
              projection_state='failed',error_code=excluded.error_code,
              width=NULL,height=NULL,taken_at=NULL,duration_ms=NULL,orientation=NULL,
              dominant_color=NULL,camera_make=NULL,camera_model=NULL,
              container=NULL,video_codec=NULL,audio_codec=NULL,codec_profile=NULL,
              codec_level=NULL,codec_tier=NULL,bit_depth=NULL`,
            values: [row.node_id, row.blob_id, VIDEO_METADATA_GENERATOR, inspection.kind],
          },
        ],
    deadline,
  );
  return "completed";
}
