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
import { CONTROL_NAME } from "../do/controlName";
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
    await atomicBatch(env.DB, [
      ...authority,
      held(claim),
      assertExists(
        "SELECT 1 FROM image_derivative_cleanup WHERE image_id=? AND retired_at IS NULL",
        [grant.id],
      ),
    ]);
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

export interface ImagePublicationRequest {
  imageId: string;
  outboxId: string;
  epoch: number;
  claimToken: string;
  expiresAt: number;
}

/** A new delivery may finish a proven stored output; it cannot renew a native dispatch grant. */
export async function resumeImageDerivative(
  env: Pick<Env, "DB" | "CONTROL">,
  request: ImagePublicationRequest,
) {
  const now = Date.now();
  if (
    !request ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.imageId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.outboxId) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.claimToken) ||
    !Number.isSafeInteger(request.epoch) ||
    request.epoch < 1 ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= now ||
    request.expiresAt > now + 25000
  )
    throw new Error("invalid_image_publication");
  // Keep one request identity across asynchronous authorization and admission.
  request = {
    imageId: request.imageId,
    outboxId: request.outboxId,
    epoch: request.epoch,
    claimToken: request.claimToken,
    expiresAt: request.expiresAt,
  };
  const row = await primary(env.DB)
    .prepare(`SELECT t.*,x.write_attempt_id,x.state AS storage_state,
      d.claim_token AS result_claim,d.claim_expires_at AS result_deadline
      FROM image_transform_attempts t JOIN image_derivative_objects x ON x.id=t.id
      JOIN derivative_results d ON d.id=x.result_id
      WHERE t.id=? AND t.state='succeeded' AND x.state IN ('stored','published')`)
    .bind(request.imageId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("image_derivative_unavailable");
  const grant = imageGrantFromRow(row),
    output = JSON.parse(row.output_json as string) as ImageTransformReceipt;
  if (
    grant.epoch !== request.epoch ||
    grant.outboxId !== request.outboxId ||
    imageOutputJson(grant, output) !== row.output_json
  )
    throw new Error("image_derivative_unavailable");
  const c: ImageDerivativeClaim = {
    grant,
    output,
    blobId: id(grant),
    key: key(grant),
    attemptId: row.write_attempt_id as string,
    state: row.storage_state as ImageDerivativeClaim["state"],
  };
  const authority = await imageTransformAuthority(env.DB, {
    ...grant,
    claimToken: request.claimToken,
    expiresAt: request.expiresAt,
  });
  const proof = await env.CONTROL.get(
    env.CONTROL.idFromName(CONTROL_NAME),
  ).imageDerivativePublicationProof(request.epoch, request.imageId);
  if (
    proof.imageId !== request.imageId ||
    proof.key !== c.key ||
    proof.outputJson !== row.output_json
  )
    throw new Error("image_publication_unproven");
  const published = c.state === "published";
  const facts = [
    ...authority,
    held(c),
    success(c),
    assertExists(
      "SELECT 1 FROM r2_write_attempts WHERE id=? AND token=? AND state='succeeded' AND r2_key=?",
      [proof.writeId, proof.writeToken, c.key],
    ),
    assertExists(
      `SELECT 1 FROM image_derivative_objects x
      JOIN image_transform_attempts t ON t.id=x.id JOIN derivative_results d ON d.id=x.result_id
      JOIN blobs b ON b.id=x.output_blob_id JOIN blob_storage s ON s.blob_id=b.id
      JOIN blob_pins p ON p.pin_id=x.pin_id JOIN reservations r ON r.id=x.reservation_id
      JOIN image_derivative_cleanup cleanup ON cleanup.image_id=x.id JOIN control ctl ON ctl.singleton=1
      WHERE x.id=? AND x.state=? AND d.state=? AND t.state='succeeded' AND t.output_json=?
      AND d.blob_id=t.blob_id AND d.kind='thumbnail' AND d.variant=t.variant AND d.generator_version=t.generator_version
      AND d.claim_token IS ? AND d.claim_expires_at IS ? AND d.epoch=t.epoch AND d.attempts=1
      AND b.owner_id=x.owner_id AND b.size=d.size AND b.size=json_extract(t.output_json,'$.bytes')
      AND b.r2_key=d.r2_key AND b.r2_key=? AND b.mime_sniffed='image/webp' AND b.state=? AND b.ref_count=1
      AND b.sha256_verified=json_extract(t.output_json,'$.sha256') AND b.r2_etag=s.r2_etag
      AND s.bytes=b.size AND s.removed_at IS NULL AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL
      AND r.owner_id=x.owner_id AND r.bytes=b.size AND r.physical_only=1 AND r.state=?
      AND r.epoch=t.epoch AND r.expires_at=t.expires_at
      AND cleanup.retired_at IS NULL AND cleanup.seal_token IS NULL AND cleanup.settled_at IS NULL
      AND ctl.epoch=? AND ctl.maintenance=0 AND ctl.backup_token IS NULL AND ctl.backup_frozen=0
      AND ctl.restore_freeze_token IS NULL AND ?>${CLOCK}+1000`,
      [
        grant.id,
        c.state,
        published ? "ready" : "running",
        row.output_json as string,
        row.result_claim as string,
        row.result_deadline as number,
        c.key,
        published ? "committed" : "staging",
        published ? "released" : "reserved",
        request.epoch,
        request.expiresAt,
      ],
    ),
  ];
  const active = () => {
    if (Date.now() < now || Date.now() >= request.expiresAt)
      throw new Error("image_publication_expired");
  };
  active();
  if (published) await atomicBatch(env.DB, facts);
  else {
    const admission = await acquireSystemMutation(
      env,
      grant.ownerId,
      "image.publish",
      request.expiresAt,
    );
    active();
    await commitSystemMutation(env.DB, admission, grant.ownerId, [
      ...facts,
      {
        sql: "UPDATE derivative_results SET claim_token=?,claim_expires_at=? WHERE id=? AND state='running'",
        values: [request.claimToken, request.expiresAt, id(grant)],
      },
      assertOneChange,
      {
        sql: "UPDATE blobs SET state='committed' WHERE id=? AND state='staging'",
        values: [c.blobId],
      },
      assertOneChange,
      {
        sql: "UPDATE derivative_results SET state='ready' WHERE id=? AND state='running'",
        values: [id(grant)],
      },
      assertOneChange,
      {
        sql: "UPDATE image_derivative_objects SET state='published' WHERE id=? AND state='stored'",
        values: [grant.id],
      },
      assertOneChange,
      {
        sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
        values: [id(grant)],
      },
      assertOneChange,
    ]);
  }
  active();
  return {
    id: id(grant),
    blobId: c.blobId,
    key: c.key,
    size: output.bytes,
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
