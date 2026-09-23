import { portableName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, atomicBatch } from "../../db/primary";
import { multipartPlan, UPLOAD_LIMITS } from "../../do/uploadPlan";
import { digestJson } from "../../jobs/operations";
import { validateLength } from "../../platform/stream";
import { reservationStatements } from "../quota";
import { type UploadRow, uploadAuthority, uploadFence, uploadRow, uploadStatus } from "./access";

export interface CreateSingleUpload {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly parentId: string;
  readonly name: string;
  readonly declaredSize: number;
  readonly targetId?: string;
  readonly targetRevision?: number;
}

/** Reservation and immutable staging metadata are committed together before any R2 call. */
export async function createSingleUpload(
  db: D1Database,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  return reserveUpload(db, input, capabilities, "single");
}

/** Metadata reservation shared by multipart initialization and its recoverable HTTP receipt. */
export async function reserveMultipartUpload(
  db: D1Database,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  return reserveUpload(db, input, capabilities, "multipart");
}

async function reserveUpload(
  db: D1Database,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
  mode: "single" | "multipart",
) {
  if (
    input.principal.kind !== "user" ||
    !/^[\x21-\x7e]{1,200}$/.test(input.requestId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.spaceId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.parentId) ||
    (input.targetId !== undefined &&
      (!/^[A-Za-z0-9_-]{1,128}$/.test(input.targetId) ||
        !Number.isSafeInteger(input.targetRevision) ||
        (input.targetRevision ?? 0) < 1)) ||
    (input.targetId === undefined && input.targetRevision !== undefined)
  )
    throw new Error("invalid_upload_create");
  const plan = mode === "multipart" ? multipartPlan(input.declaredSize) : null;
  if (!plan) validateLength(input.declaredSize);
  const name = portableName(input.name);
  const id = `up_${await digestJson(["upload.create", input.principal.credential_id, input.requestId])}`;
  const digest = await digestJson({
    spaceId: input.spaceId,
    parentId: input.parentId,
    name: name.name,
    mode,
    size: input.declaredSize,
    targetId: input.targetId ?? null,
    targetRevision: input.targetRevision ?? null,
  });
  const replay = async () => {
    const row = await uploadRow(db, id);
    if (!row) return null;
    if (row.request_digest !== digest || row.epoch !== input.principal.epoch)
      throw new Error("idempotency_conflict");
    const authorized = await uploadAuthority(db, input.principal, row, row.state !== "completed");
    await atomicBatch(db, [
      authorizationAssertion(authorized),
      uploadFence(row, [row.state], false),
    ]);
    const capability = await capabilities.issue(row);
    if ((await digestJson(capability)) !== row.capability_hash)
      throw new Error("upload_capability_mismatch");
    return { ...uploadStatus(row), capability };
  };
  const existing = await replay();
  if (existing) return existing;
  const authorized = await authorizeNode(
    db,
    input.principal,
    input.targetId
      ? {
          operation: "node.content.write",
          spaceId: input.spaceId,
          nodeId: input.targetId,
        }
      : { operation: "node.create", spaceId: input.spaceId, parentId: input.parentId },
  );
  if (
    authorized.operation === "node.content.write" &&
    (authorized.parentId !== input.parentId ||
      authorized.node.revision !== input.targetRevision ||
      authorized.node.name !== name.name)
  )
    throw new Error("upload_target_changed");
  if (authorized.operation !== "node.create" && authorized.operation !== "node.content.write")
    throw new Error("upload_authorization_denied");
  const owner =
    authorized.operation === "node.create" ? authorized.parent.owner_id : authorized.node.owner_id;
  const now = Date.now();
  const identity = {
    id,
    credential_id: input.principal.credential_id,
    epoch: input.principal.epoch,
    expires_at: now + (plan ? UPLOAD_LIMITS.lifetimeMs : 86400000),
    capability_kid: capabilities.ring.activeKid,
  };
  const capability = await capabilities.issue(identity);
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  try {
    await atomicBatch(db, [
      authorizationAssertion(authorized),
      ...reservationStatements({
        id: reservation,
        ownerId: owner,
        bytes: input.declaredSize,
        expiresAt: identity.expires_at,
        epoch: input.principal.epoch,
      }),
      {
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at)
        VALUES(?,?,?, ?,?,'application/octet-stream','staging',?)`,
        values: [blob, owner, `u/${owner}/b/${blob}`, input.declaredSize, `"b-${blob}"`, now],
      },
      {
        sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,target_id,blob_id,credential_id,reservation_id,
        mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,
        upload_name,target_revision,request_digest,capability_kid,part_bytes,part_count)
        VALUES(?,?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,?,?)`,
        values: [
          id,
          owner,
          input.spaceId,
          input.parentId,
          input.targetId ?? null,
          blob,
          input.principal.credential_id,
          reservation,
          mode,
          input.declaredSize,
          await digestJson(capability),
          input.principal.epoch,
          now,
          identity.expires_at,
          now,
          name.name,
          input.targetRevision ?? null,
          digest,
          identity.capability_kid,
          plan?.partBytes ?? null,
          plan?.partCount ?? null,
        ],
      },
      assertExists("SELECT 1 FROM uploads WHERE id=? AND request_digest=?", [id, digest]),
    ]);
  } catch (error) {
    // Same-key races and a lost batch response are resolved from current D1 rows, never recharged.
    const recovered = await replay();
    if (recovered) return recovered;
    throw error;
  }
  const row = (await uploadRow(db, id)) as UploadRow;
  return { ...uploadStatus(row), capability };
}
