import { LIMITS } from "@next-cloud-flare/shared/limits";
import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import {
  IMAGE_METADATA_GENERATOR,
  type ImageMetadata,
  inspectImage,
} from "../media/images/metadata";
import {
  generateThumbnail,
  IMAGE_THUMBNAIL_GENERATOR,
  IMAGE_THUMBNAIL_VARIANT,
} from "../media/images/thumbnail";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";

const CLOCK = "strftime('%s','now')*1000";
const DERIVATIVE_CLAIM_MS = 30_000;

export type MediaJobEnv = SystemMutationSource & {
  readonly BLOBS: R2Bucket;
  readonly IMAGES: ImagesBinding;
};

interface MediaSource {
  node_id: string;
  space_id: string;
  owner_id: string;
  blob_id: string;
  r2_key: string;
  size: number;
  r2_etag: string;
  state: string;
}

interface DerivativeRow {
  id: string;
  state: "pending" | "running" | "ready" | "failed";
  claim_token: string | null;
  claim_expires_at: number | null;
  epoch: number;
  attempts: number;
}

export interface MediaOutboxClaim {
  readonly outboxId: string;
  readonly outboxToken: string;
  readonly epoch: number;
  readonly ownerId: string;
  readonly nodeId: string;
  readonly operationKind: string;
  readonly operandsJson: string;
  readonly resultJson: string | null;
}

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

function sourceFence(source: MediaSource): SqlStatement {
  return assertExists(
    `SELECT 1 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage s ON s.blob_id=b.id
      WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.kind='file'
        AND n.deleted_at IS NULL AND n.current_blob_id=?
        AND b.owner_id=? AND b.r2_key=? AND b.size=? AND b.state IN ('committed','gc_candidate')
        AND s.bytes=? AND s.r2_etag=? AND s.removed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM blob_encryption be WHERE be.blob_id=b.id)`,
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

async function mutate(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  statements: readonly SqlStatement[],
  deadline: number,
): Promise<void> {
  const admission = await acquireSystemMutation(env, claim.ownerId, "media.project", deadline);
  await commitSystemMutation(env.DB, admission, claim.ownerId, [
    authorizationAssertion(authorized),
    outboxFence(claim),
    ...statements,
  ]);
}

async function source(db: D1Database, nodeId: string): Promise<MediaSource | null> {
  return primary(db)
    .prepare(`SELECT n.id AS node_id,n.space_id,n.owner_id,b.id AS blob_id,b.r2_key,b.size,
      s.r2_etag,b.state FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage s ON s.blob_id=b.id
      WHERE n.id=? AND n.kind='file' AND n.deleted_at IS NULL
        AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
        AND b.owner_id=n.owner_id AND s.bytes=b.size
        AND NOT EXISTS(SELECT 1 FROM blob_encryption be WHERE be.blob_id=b.id)`)
    .bind(nodeId)
    .first<MediaSource>();
}

async function readSource(bucket: R2Bucket, row: MediaSource): Promise<Uint8Array> {
  if (
    row.r2_key !== `u/${row.owner_id}/b/${row.blob_id}` ||
    !Number.isSafeInteger(row.size) ||
    row.size < 1 ||
    row.size > LIMITS.imageBytes
  )
    throw new RangeError("image_too_large");
  const object = await bucket.get(row.r2_key);
  if (!object || object.size !== row.size || object.etag !== row.r2_etag)
    throw new Error("image_source_unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== row.size) throw new Error("image_source_length");
  return bytes;
}

async function persistMetadata(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: MediaSource,
  metadata: ImageMetadata,
  deadline: number,
): Promise<void> {
  await mutate(
    env,
    claim,
    authorized,
    [
      sourceFence(row),
      {
        sql: `UPDATE blobs SET mime_sniffed=? WHERE id=? AND owner_id=?
          AND state IN ('committed','gc_candidate')`,
        values: [metadata.mime, row.blob_id, row.owner_id],
      },
      assertExists("SELECT 1 FROM blobs WHERE id=? AND mime_sniffed=?", [
        row.blob_id,
        metadata.mime,
      ]),
      {
        sql: `INSERT INTO node_media(node_id,blob_id,generator_version,width,height)
          VALUES(?,?,?,?,?)
          ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,
            generator_version=excluded.generator_version,width=excluded.width,height=excluded.height,
            projection_state='ready',error_code=NULL,
            taken_at=NULL,duration_ms=NULL,orientation=NULL,dominant_color=NULL,camera_make=NULL,camera_model=NULL,
            container=NULL,video_codec=NULL,audio_codec=NULL,codec_profile=NULL,codec_level=NULL,
            codec_tier=NULL,bit_depth=NULL`,
        values: [
          row.node_id,
          row.blob_id,
          IMAGE_METADATA_GENERATOR,
          metadata.width,
          metadata.height,
        ],
      },
    ],
    deadline,
  );
}

async function failUnsupported(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: MediaSource,
  errorCode: string,
  deadline: number,
): Promise<void> {
  const id = crypto.randomUUID();
  await mutate(
    env,
    claim,
    authorized,
    [
      sourceFence(row),
      {
        sql: "DELETE FROM node_media WHERE node_id=?",
        values: [row.node_id],
      },
      {
        sql: `INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,epoch,attempts,error_code)
          VALUES(?,?,'thumbnail',?,?,'failed',?,0,?)
          ON CONFLICT(kind,blob_id,variant,generator_version) DO UPDATE SET
            state='failed',claim_token=NULL,claim_expires_at=NULL,r2_key=NULL,size=NULL,r2_etag=NULL,
            error_code=excluded.error_code
          WHERE derivative_results.state IN ('pending','running')`,
        values: [
          id,
          row.blob_id,
          IMAGE_THUMBNAIL_VARIANT,
          IMAGE_THUMBNAIL_GENERATOR,
          claim.epoch,
          errorCode,
        ],
      },
    ],
    deadline,
  );
}

async function claimDerivative(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: MediaSource,
  deadline: number,
): Promise<DerivativeRow | null> {
  const existing = await primary(env.DB)
    .prepare(`SELECT id,state,claim_token,claim_expires_at,epoch,attempts FROM derivative_results
      WHERE kind='thumbnail' AND blob_id=? AND variant=? AND generator_version=?`)
    .bind(row.blob_id, IMAGE_THUMBNAIL_VARIANT, IMAGE_THUMBNAIL_GENERATOR)
    .first<DerivativeRow>();
  if (existing?.state === "ready" || existing?.state === "failed") return existing;
  if (
    existing?.state === "running" &&
    existing.claim_expires_at !== null &&
    existing.claim_expires_at > Date.now()
  )
    return null;
  if (existing && (existing.epoch !== claim.epoch || existing.attempts >= 3)) {
    await mutate(
      env,
      claim,
      authorized,
      [
        sourceFence(row),
        {
          sql: `UPDATE derivative_results SET state='failed',claim_token=NULL,claim_expires_at=NULL,
            r2_key=NULL,size=NULL,r2_etag=NULL,error_code=?
            WHERE id=? AND state IN ('pending','running') AND epoch=? AND attempts=?`,
          values: [
            existing.attempts >= 3 ? "attempts_exhausted" : "epoch_changed",
            existing.id,
            existing.epoch,
            existing.attempts,
          ],
        },
        assertOneChange,
      ],
      deadline,
    );
    return { ...existing, state: "failed" };
  }
  const id = existing?.id ?? crypto.randomUUID();
  const token = crypto.randomUUID();
  await mutate(
    env,
    claim,
    authorized,
    [
      sourceFence(row),
      {
        sql: `INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,epoch)
          VALUES(?,?,'thumbnail',?,?,'pending',?)
          ON CONFLICT(kind,blob_id,variant,generator_version) DO NOTHING`,
        values: [id, row.blob_id, IMAGE_THUMBNAIL_VARIANT, IMAGE_THUMBNAIL_GENERATOR, claim.epoch],
      },
      {
        sql: `UPDATE derivative_results SET state='running',claim_token=?,
          claim_expires_at=${CLOCK}+?,attempts=attempts+1,error_code=NULL
          WHERE id=? AND epoch=? AND attempts<3
            AND (state='pending' OR (state='running' AND claim_expires_at<=${CLOCK}))`,
        values: [token, DERIVATIVE_CLAIM_MS, id, claim.epoch],
      },
      assertOneChange,
    ],
    deadline,
  );
  return primary(env.DB)
    .prepare(`SELECT id,state,claim_token,claim_expires_at,epoch,attempts FROM derivative_results
      WHERE id=? AND state='running' AND claim_token=?`)
    .bind(id, token)
    .first<DerivativeRow>();
}

async function failClaim(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: MediaSource,
  derivative: DerivativeRow,
  errorCode: string,
  deadline: number,
): Promise<void> {
  await mutate(
    env,
    claim,
    authorized,
    [
      sourceFence(row),
      {
        sql: `UPDATE derivative_results SET state='failed',claim_token=NULL,claim_expires_at=NULL,
          r2_key=NULL,size=NULL,r2_etag=NULL,error_code=?
          WHERE id=? AND state='running' AND claim_token=? AND claim_expires_at>${CLOCK}
            AND epoch=? AND attempts=?`,
        values: [
          errorCode,
          derivative.id,
          derivative.claim_token,
          claim.epoch,
          derivative.attempts,
        ],
      },
      assertOneChange,
    ],
    deadline,
  );
}

async function publish(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  row: MediaSource,
  derivative: DerivativeRow,
  bytes: Uint8Array,
  deadline: number,
): Promise<void> {
  const key = `u/${row.owner_id}/d/${row.blob_id}/${IMAGE_THUMBNAIL_GENERATOR}/${IMAGE_THUMBNAIL_VARIANT}/${derivative.claim_token}.webp`;
  const object = await env.BLOBS.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!object || object.size !== bytes.byteLength || !object.etag)
    throw new Error("thumbnail_publication_failed");
  await mutate(
    env,
    claim,
    authorized,
    [
      sourceFence(row),
      {
        sql: `UPDATE derivative_results SET state='ready',claim_token=NULL,claim_expires_at=NULL,
          r2_key=?,size=?,r2_etag=?,error_code=NULL
          WHERE id=? AND state='running' AND claim_token=? AND claim_expires_at>${CLOCK}
            AND epoch=? AND attempts=? AND generator_version=?`,
        values: [
          key,
          object.size,
          object.etag,
          derivative.id,
          derivative.claim_token,
          claim.epoch,
          derivative.attempts,
          IMAGE_THUMBNAIL_GENERATOR,
        ],
      },
      assertOneChange,
    ],
    deadline,
  );
}

function terminal(error: unknown): string | null {
  if (error instanceof RangeError)
    return error.message === "image_too_large" ? "input_limits" : "output_limits";
  if (error instanceof Error) {
    if (error.message === "thumbnail_output_type") return "output_type";
    if (error.message === "thumbnail_output_empty") return "missing_output";
  }
  return null;
}

export async function processImageOutbox(
  env: MediaJobEnv,
  claim: MediaOutboxClaim,
  authorized: AuthorizedNode,
  deadline: number,
): Promise<"completed" | "retry"> {
  if (Date.now() >= deadline) return "retry";
  if (authorized.operation !== "node.read") return "completed";
  const row = await source(env.DB, claim.nodeId);
  if (!row || row.owner_id !== claim.ownerId || row.space_id !== authorized.node.space_id)
    return "completed";
  let bytes: Uint8Array;
  let metadata: ImageMetadata | null;
  try {
    bytes = await readSource(env.BLOBS, row);
    metadata = await inspectImage(env.IMAGES, bytes);
  } catch (error) {
    const errorCode =
      terminal(error) ??
      (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 9412
        ? "unsupported_format"
        : null);
    if (!errorCode) return "retry";
    await failUnsupported(env, claim, authorized, row, errorCode, deadline);
    return "completed";
  }
  if (!metadata) {
    await failUnsupported(env, claim, authorized, row, "unsupported_format", deadline);
    return "completed";
  }
  await persistMetadata(env, claim, authorized, row, metadata, deadline);
  const derivative = await claimDerivative(env, claim, authorized, row, deadline);
  if (!derivative) return "retry";
  if (derivative.state === "ready" || derivative.state === "failed") return "completed";
  try {
    const output = await generateThumbnail(env.IMAGES, bytes);
    await publish(env, claim, authorized, row, derivative, output, deadline);
    return "completed";
  } catch (error) {
    const errorCode = terminal(error);
    if (errorCode || derivative.attempts >= 3) {
      await failClaim(
        env,
        claim,
        authorized,
        row,
        derivative,
        errorCode ?? "attempts_exhausted",
        deadline,
      );
      return "completed";
    }
    return "retry";
  }
}
