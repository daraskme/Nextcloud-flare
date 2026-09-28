import {
  type ImageTransformGrant,
  type ImageTransformReceipt,
  imageGrantFromRow,
  imageOutputJson,
  imageTransformAuthority,
} from "../db/imageTransform";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { Env } from "../env";
import type { ImageTransformOutput } from "../media/images/transform";
import { hex } from "../platform/stream";
import { trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";

type ImageStoreEnv = Pick<Env, "DB" | "BLOBS" | "CONTROL">;
const CLOCK = "strftime('%s','now')*1000";
export interface ImageDerivativeClaim {
  grant: ImageTransformGrant;
  output: ImageTransformReceipt;
  blobId: string;
  key: string;
  attemptId: string;
  state: "prepared" | "stored" | "published";
}
const id = (g: ImageTransformGrant) => "image_" + g.id;
const key = (g: ImageTransformGrant) =>
  `u/${g.ownerId}/d/${g.blobId}/${g.generator}/${g.variant}/${g.id}`;
function current(g: ImageTransformGrant) {
  if (Date.now() < g.startedAt || Date.now() >= g.expiresAt)
    throw new Error("image_derivative_expired");
}
const held = (c: ImageDerivativeClaim): SqlStatement =>
  assertExists(
    `SELECT 1 FROM image_derivative_objects
  WHERE id=? AND owner_id=? AND source_blob_id=? AND output_blob_id=? AND result_id=? AND reservation_id=? AND pin_id=? AND write_attempt_id=?`,
    [
      c.grant.id,
      c.grant.ownerId,
      c.grant.blobId,
      c.blobId,
      id(c.grant),
      id(c.grant),
      id(c.grant),
      c.attemptId,
    ],
  );
const success = (c: ImageDerivativeClaim): SqlStatement =>
  assertExists(
    `SELECT 1 FROM r2_write_attempts WHERE kind='image.put'
  AND state='succeeded' AND source_ref=? AND owner_id=? AND epoch=? AND r2_key=?
  AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')`,
    [JSON.stringify([c.grant.id, c.attemptId]), c.grant.ownerId, c.grant.epoch, c.key, c.key],
  );

/** Prepare a fixed result only from a validated successful native image receipt. */
export async function prepareImageDerivative(
  env: ImageStoreEnv,
  imageId: string,
  output: ImageTransformOutput,
): Promise<ImageDerivativeClaim> {
  const row = await primary(env.DB)
    .prepare("SELECT * FROM image_transform_attempts WHERE id=? AND state='succeeded'")
    .bind(imageId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("image_derivative_unavailable");
  const grant = imageGrantFromRow(row);
  current(grant);
  const receipt: ImageTransformReceipt = {
    bytes: output.bytes.length,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
  };
  if (
    output.mime !== "image/webp" ||
    imageOutputJson(grant, receipt) !== row.output_json ||
    hex(await crypto.subtle.digest("SHA-256", output.bytes)) !== receipt.sha256
  )
    throw new Error("image_derivative_output_mismatch");
  const existing = await primary(env.DB)
    .prepare("SELECT write_attempt_id,state FROM image_derivative_objects WHERE id=?")
    .bind(grant.id)
    .first<{ write_attempt_id: string; state: ImageDerivativeClaim["state"] }>();
  const claim: ImageDerivativeClaim = {
    grant,
    output: receipt,
    blobId: id(grant),
    key: key(grant),
    attemptId: existing?.write_attempt_id ?? crypto.randomUUID(),
    state: existing?.state ?? "prepared",
  };
  const authority = await imageTransformAuthority(env.DB, grant);
  if (existing) {
    await atomicBatch(env.DB, [...authority, held(claim)]);
    current(grant);
    return claim;
  }
  const admission = await acquireSystemMutation(
    env,
    grant.ownerId,
    "image.prepare",
    grant.expiresAt,
  );
  current(grant);
  // Direct ACK is required before any PUT; a lost prepare reply leaves a reservation for repair.
  await atomicBatch(
    env.DB,
    systemMutationStatements(admission, grant.ownerId, [
      ...authority,
      assertExists(
        "SELECT 1 FROM image_transform_attempts WHERE id=? AND state='succeeded' AND output_json=?",
        [grant.id, row.output_json as string],
      ),
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,physical_only) VALUES(?,?,?,'reserved',?,?,1)",
        values: [id(grant), grant.ownerId, receipt.bytes, grant.expiresAt, grant.epoch],
      },
      {
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at) VALUES(?,?,?,?,?,'image/webp','staging',${CLOCK})`,
        values: [claim.blobId, grant.ownerId, claim.key, receipt.bytes, '"d-' + grant.id + '"'],
      },
      {
        sql: `INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?,?,'job',NULL,${CLOCK})`,
        values: [id(grant), claim.blobId],
      },
      {
        sql: "INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,r2_key,size) VALUES(?,?,'thumbnail',?,?,'running',?,?,?,1,?,?)",
        values: [
          id(grant),
          grant.blobId,
          grant.variant,
          grant.generator,
          grant.claimToken,
          grant.expiresAt,
          grant.epoch,
          claim.key,
          receipt.bytes,
        ],
      },
      {
        sql: `INSERT INTO image_derivative_objects VALUES(?,?,?,?,?,?,?,?,'prepared',${CLOCK})`,
        values: [
          grant.id,
          grant.ownerId,
          grant.blobId,
          claim.blobId,
          id(grant),
          id(grant),
          id(grant),
          claim.attemptId,
        ],
      },
      assertOneChange,
    ]),
  );
  current(grant);
  return claim;
}

/** Record actual bytes even after revocation, deadline or epoch change; this does not publish. */
export async function observeImageDerivative(
  env: ImageStoreEnv,
  c: ImageDerivativeClaim,
  object: R2Object,
) {
  if (
    object.key !== c.key ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    !object.etag ||
    object.etag.length > 256
  )
    throw new Error("image_derivative_object_mismatch");
  const sha = object.checksums.sha256 ? hex(object.checksums.sha256) : null;
  const admission = await acquireSystemMutation(env, c.grant.ownerId, "image.observe");
  await commitSystemMutation(env.DB, admission, c.grant.ownerId, [
    held(c),
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
      values: [c.blobId, object.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [c.blobId, object.size, object.etag],
    ),
    {
      sql: "UPDATE blobs SET sha256_verified=?,r2_etag=? WHERE id=? AND state='staging'",
      values: [sha, object.etag, c.blobId],
    },
    assertOneChange,
    {
      sql: "UPDATE image_derivative_objects SET state='stored' WHERE id=? AND state IN ('prepared','stored')",
      values: [c.grant.id],
    },
    assertOneChange,
  ]);
}

/** Current source/authority and completed native PUT are checked in the publication transaction. */
export async function publishImageDerivative(env: ImageStoreEnv, c: ImageDerivativeClaim) {
  current(c.grant);
  const authority = await imageTransformAuthority(env.DB, c.grant);
  const admission = await acquireSystemMutation(
    env,
    c.grant.ownerId,
    "image.publish",
    c.grant.expiresAt,
  );
  current(c.grant);
  await commitSystemMutation(env.DB, admission, c.grant.ownerId, [
    ...authority,
    held(c),
    success(c),
    assertExists(
      `SELECT 1 FROM image_transform_attempts t JOIN derivative_results d ON d.id=?
      WHERE t.id=? AND t.state='succeeded' AND t.output_json=? AND d.state='running' AND d.blob_id=t.blob_id
      AND d.kind='thumbnail' AND d.variant=t.variant AND d.generator_version=t.generator_version
      AND d.claim_token=t.claim_token AND d.claim_expires_at=t.expires_at AND d.epoch=t.epoch
      AND t.expires_at>${CLOCK}+1000`,
      [id(c.grant), c.grant.id, imageOutputJson(c.grant, c.output)],
    ),
    {
      sql: "UPDATE blobs SET state='committed' WHERE id=? AND state='staging'",
      values: [c.blobId],
    },
    assertOneChange,
    {
      sql: "UPDATE derivative_results SET state='ready' WHERE id=? AND state='running'",
      values: [id(c.grant)],
    },
    assertOneChange,
    {
      sql: "UPDATE image_derivative_objects SET state='published' WHERE id=? AND state='stored'",
      values: [c.grant.id],
    },
    assertOneChange,
    {
      sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
      values: [id(c.grant)],
    },
    assertOneChange,
  ]);
  return {
    id: id(c.grant),
    blobId: c.blobId,
    key: c.key,
    size: c.output.bytes,
    mime: "image/webp" as const,
  };
}

/** Internal storage pipeline; Queue and thumb delivery are separate callers. */
export async function storeImageDerivative(
  env: ImageStoreEnv,
  imageId: string,
  output: ImageTransformOutput,
) {
  const claim = await prepareImageDerivative(env, imageId, output);
  if (claim.state === "published")
    return {
      id: id(claim.grant),
      blobId: claim.blobId,
      key: claim.key,
      size: claim.output.bytes,
      mime: "image/webp" as const,
    };
  if (claim.state === "prepared") {
    let observed = false;
    const checksum = await crypto.subtle.digest("SHA-256", output.bytes);
    const object = await trackedR2Write(
      env,
      {
        epoch: claim.grant.epoch,
        ownerId: claim.grant.ownerId,
        kind: "image.put",
        key: claim.key,
        image: {
          imageId,
          attemptId: claim.attemptId,
          claimToken: claim.grant.claimToken,
          expiresAt: claim.grant.expiresAt,
        },
      },
      async () => {
        const result = await env.BLOBS.put(claim.key, output.bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: checksum,
          httpMetadata: { contentType: "image/webp" },
        });
        if (result) {
          try {
            await observeImageDerivative(env, claim, result);
            observed = true;
          } catch {
            /* Retain physical reservation and still record the actual native end. */
          }
        }
        return result;
      },
      claim.grant.expiresAt,
      () => current(claim.grant),
    );
    if (!object) throw new Error("image_derivative_destination_exists");
    if (!observed) await observeImageDerivative(env, claim, object);
  }
  return publishImageDerivative(env, claim);
}
