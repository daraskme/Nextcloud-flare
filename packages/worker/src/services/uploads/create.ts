import { portableName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, atomicBatch } from "../../db/primary";
import { multipartPlan, UPLOAD_LIMITS } from "../../do/uploadPlan";
import { digestJson } from "../../jobs/operations";
import { validateLength } from "../../platform/stream";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "../accountMutation";
import { reservationStatements } from "../quota";
import { type UploadRow, uploadAuthority, uploadFence, uploadRow, uploadStatus } from "./access";

const MAX_PUBLIC_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ACTIVE_PUBLIC_UPLOADS = 8;
const MAX_PUBLIC_UPLOADS = 1_000;

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

function publicUploadName(input: string, id: string) {
  const original = portableName(input).name;
  const dot = original.lastIndexOf(".");
  const extension =
    dot > 0 && /^[.A-Za-z0-9_-]{1,21}$/.test(original.slice(dot)) ? original.slice(dot) : "";
  const stem = Array.from(extension ? original.slice(0, -extension.length) : original);
  const suffix = ` (${id.slice(3, 11).toUpperCase()})`;
  while (stem.length) {
    try {
      return portableName(`${stem.join("")}${suffix}${extension}`);
    } catch {
      stem.pop();
    }
  }
  return portableName(`upload${suffix}${extension}`);
}

async function publicUploadExpiry(
  db: D1Database,
  principal: Extract<Principal, { kind: "link_share" }>,
): Promise<number> {
  const row = await db
    .prepare(`SELECT MIN(ss.expires_at,COALESCE(sh.expires_at,ss.expires_at)) AS expiresAt
      FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
      JOIN shares sh ON sh.id=ss.share_id
      WHERE c.id=? AND c.kind='share' AND sh.id=? AND sh.kind='upload_only'
        AND sh.version=? AND ss.share_version=sh.version AND ss.epoch=?
        AND ss.revoked_at IS NULL AND sh.disabled_at IS NULL
        AND ss.expires_at>strftime('%s','now')*1000
        AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
        AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='upload')`)
    .bind(principal.credential_id, principal.share_id, principal.share_version, principal.epoch)
    .first<number>("expiresAt");
  if (row === null) throw new Error("upload_authorization_denied");
  return row;
}

/** Reservation and immutable staging metadata are committed together before any R2 call. */
export async function createSingleUpload(
  env: AccountMutationEnv,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  return reserveUpload(env, input, capabilities, "single");
}

/** Metadata reservation shared by multipart initialization and its recoverable HTTP receipt. */
export async function reserveMultipartUpload(
  env: AccountMutationEnv,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  return reserveUpload(env, input, capabilities, "multipart");
}

async function reserveUpload(
  env: AccountMutationEnv,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
  mode: "single" | "multipart",
) {
  const db = env.DB;
  if (
    !["user", "link_share"].includes(input.principal.kind) ||
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
  if (
    input.principal.kind === "link_share" &&
    (input.targetId !== undefined ||
      !Number.isSafeInteger(input.declaredSize) ||
      input.declaredSize < 0 ||
      input.declaredSize > MAX_PUBLIC_UPLOAD_BYTES)
  )
    throw new Error("invalid_upload_create");
  const plan = mode === "multipart" ? multipartPlan(input.declaredSize) : null;
  if (!plan) validateLength(input.declaredSize);
  const id = `up_${await digestJson(["upload.create", input.principal.credential_id, input.requestId])}`;
  const name =
    input.principal.kind === "link_share"
      ? publicUploadName(input.name, id)
      : portableName(input.name);
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
    // Recover the same receipt so the caller can inspect/cancel a stale replacement.
    // This grants no new dispatch: creation, transfers and commit still check its revision.
    const authorized = await uploadAuthority(db, input.principal, row, false);
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
  const expiresAt =
    input.principal.kind === "link_share"
      ? Math.min(
          await publicUploadExpiry(db, input.principal),
          now + (plan ? UPLOAD_LIMITS.lifetimeMs : 86_400_000),
        )
      : now + (plan ? UPLOAD_LIMITS.lifetimeMs : 86_400_000);
  if (expiresAt <= now) throw new Error("upload_expired");
  const identity = {
    id,
    credential_id: input.principal.credential_id,
    epoch: input.principal.epoch,
    expires_at: expiresAt,
    capability_kid: capabilities.ring.activeKid,
  };
  const capability = await capabilities.issue(identity);
  const capabilityHash = await digestJson(capability);
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  await atomicBatch(db, [authorizationAssertion(authorized)]);
  const admission = await acquireAccountMutation(
    env,
    owner,
    input.principal.epoch,
    "upload.reserve",
  );
  try {
    await commitAccountMutation(db, admission, owner, [
      authorizationAssertion(authorized),
      ...(input.principal.kind === "link_share"
        ? [
            assertExists(
              `SELECT 1 WHERE
                (SELECT COUNT(*) FROM uploads u JOIN reservations r ON r.id=u.reservation_id
                  WHERE r.share_id=? AND u.state NOT IN ('completed','failed','expired','aborted'))<?
                AND
                (SELECT COUNT(*) FROM uploads u JOIN reservations r ON r.id=u.reservation_id
                  WHERE r.share_id=?)<?`,
              [
                input.principal.share_id,
                MAX_ACTIVE_PUBLIC_UPLOADS,
                input.principal.share_id,
                MAX_PUBLIC_UPLOADS,
              ],
            ),
          ]
        : []),
      ...reservationStatements({
        id: reservation,
        ownerId: owner,
        bytes: input.declaredSize,
        expiresAt: identity.expires_at,
        epoch: input.principal.epoch,
        ...(input.principal.kind === "link_share"
          ? {
              share: {
                id: input.principal.share_id,
                version: input.principal.share_version,
              },
            }
          : {}),
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
          capabilityHash,
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
    // The shared request receipt may belong to a concurrent attempt. Returning it does not
    // prove this admission committed or release its uncertain slot, and never dispatches R2.
    const recovered = await replay();
    if (recovered) return recovered;
    throw error;
  }
  const row = (await uploadRow(db, id)) as UploadRow;
  return { ...uploadStatus(row), capability };
}
