import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertOpenPermit } from "../db/permits";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  prepare,
  primary,
  type SqlStatement,
} from "../db/primary";
import { assertOperationClaim, type OperationClaim } from "../jobs/operations";
import type { PutFileRequest } from "./putFile";
import { reservationStatements } from "./quota";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "./systemMutation";

const CLOCK = "strftime('%s','now')*1000";
export interface DavUploadRow {
  id: string;
  owner_id: string;
  space_id: string;
  parent_id: string;
  target_id: string | null;
  target_revision: number | null;
  blob_id: string;
  reservation_id: string;
  credential_id: string;
  epoch: number;
  declared_size: number;
  request_digest: string;
  completion_op_id: string;
  write_attempt_id: string;
  write_lease_expires_at: number;
  expires_at: number;
  state: string;
}
export interface StoredDavBody {
  readonly object: R2Object;
  readonly sha256: string;
}

export function davUploadRow(db: D1Database, op: string): Promise<DavUploadRow | null> {
  return primary(db)
    .prepare("SELECT * FROM uploads WHERE id=? AND source='dav' AND completion_op_id=?")
    .bind("dav_" + op, op)
    .first<DavUploadRow>();
}
export function davUploadMetadata(row: DavUploadRow) {
  return {
    upload_id: row.id,
    attempt_id: row.write_attempt_id,
    epoch: String(row.epoch),
    blob_id: row.blob_id,
  };
}
export function matchesDavObject(row: DavUploadRow, object: R2Object): boolean {
  return (
    object.size === row.declared_size &&
    object.etag.length > 0 &&
    object.etag.length <= 256 &&
    Object.entries(davUploadMetadata(row)).every(([k, v]) => object.customMetadata?.[k] === v)
  );
}

/** Only the direct ACK of this unique INSERT permits the one conditional R2 PUT. */
export async function startDavUpload(
  db: D1Database,
  claim: OperationClaim,
  authorized: AuthorizedNode,
  request: PutFileRequest,
  owner: string,
): Promise<DavUploadRow> {
  const now = Date.now(),
    op = claim.intent.id;
  const row: DavUploadRow = {
    id: "dav_" + op,
    owner_id: owner,
    space_id: request.spaceId,
    parent_id: request.parentId,
    target_id: request.nodeId ?? null,
    target_revision:
      authorized.operation === "node.content.write" ? authorized.node.revision : null,
    blob_id: op + "_blob",
    reservation_id: op + "_reservation",
    credential_id: request.principal.credential_id,
    epoch: claim.permit.epoch,
    declared_size: request.size,
    request_digest: claim.intent.digest,
    completion_op_id: op,
    write_attempt_id: crypto.randomUUID(),
    write_lease_expires_at: now + 900_000,
    expires_at: now + 86_400_000,
    state: "receiving",
  };
  await atomicBatch(db, [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(authorized),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM uploads WHERE id=?)", [row.id]),
    ...reservationStatements({
      id: row.reservation_id,
      ownerId: owner,
      bytes: request.size,
      expiresAt: row.expires_at,
      epoch: row.epoch,
      operationId: op,
    }),
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
        VALUES(?,?,?,?,?,'staging',?)`,
      values: [
        row.blob_id,
        owner,
        `u/${owner}/b/${row.blob_id}`,
        request.size,
        `"b-${row.blob_id}"`,
        now,
      ],
    },
    assertOneChange,
    {
      sql: `INSERT INTO uploads(id,source,owner_id,space_id,parent_id,target_id,target_revision,blob_id,reservation_id,
        credential_id,epoch,mode,state,declared_size,capability_hash,upload_name,request_digest,completion_op_id,
        write_attempt_id,write_lease_expires_at,created_at,expires_at,last_progress_at,accept_parts,in_flight,data_calls,data_bytes)
        VALUES(?,'dav',?,?,?,?,?,?,?,?,?,'single','receiving',?,'internal:dav',?,?,?,?,?,?,?,?,0,1,1,?)`,
      values: [
        row.id,
        owner,
        row.space_id,
        row.parent_id,
        row.target_id,
        row.target_revision,
        row.blob_id,
        row.reservation_id,
        row.credential_id,
        row.epoch,
        row.declared_size,
        request.name,
        row.request_digest,
        op,
        row.write_attempt_id,
        row.write_lease_expires_at,
        now,
        row.expires_at,
        now,
        request.size,
      ],
    },
    assertOneChange,
  ]);
  return row;
}

/** Bind saved facts to the original attempt and DAV operation, never to the caller's current owner. */
function source(row: DavUploadRow): SqlStatement {
  return {
    sql: `SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
    JOIN blobs b ON b.id=u.blob_id JOIN operations o ON o.op_id=u.completion_op_id
    JOIN spaces space ON space.id=u.space_id AND space.owner_id=u.owner_id JOIN control c ON c.singleton=1
    WHERE (u.id=? AND u.source='dav' AND u.owner_id=? AND u.space_id=? AND u.parent_id=? AND u.target_id IS ?
      AND u.target_revision IS ? AND u.blob_id=? AND u.reservation_id=? AND u.credential_id=? AND u.epoch=?)
      AND (u.declared_size=? AND u.request_digest=? AND u.completion_op_id=? AND u.write_attempt_id=?
      AND u.write_lease_expires_at=? AND u.expires_at=? AND u.mode='single' AND c.epoch=u.epoch)
      AND (r.owner_id=u.owner_id AND r.bytes=u.declared_size AND r.epoch=u.epoch AND r.expires_at=u.expires_at
      AND r.share_id IS NULL AND r.op_id=o.op_id)
      AND (b.owner_id=u.owner_id AND b.size=u.declared_size AND b.ref_count=0
      AND b.r2_key='u/'||u.owner_id||'/b/'||u.blob_id)
      AND (o.kind='dav.put' AND o.principal_kind='app_password' AND o.credential_id=u.credential_id
      AND o.epoch=u.epoch AND o.space_id=u.space_id AND o.request_digest=u.request_digest
      AND json_extract(o.operands_json,'$.parentId')=u.parent_id
      AND json_extract(o.operands_json,'$.nodeId') IS u.target_id)
      AND NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=o.op_id)`,
    values: [
      row.id,
      row.owner_id,
      row.space_id,
      row.parent_id,
      row.target_id,
      row.target_revision,
      row.blob_id,
      row.reservation_id,
      row.credential_id,
      row.epoch,
      row.declared_size,
      row.request_digest,
      row.completion_op_id,
      row.write_attempt_id,
      row.write_lease_expires_at,
      row.expires_at,
    ],
  };
}

/** Native PUT completion is a storage fact even if the publication permit or credential expired. */
export async function recordStoredDavUpload(
  env: SystemMutationSource,
  row: DavUploadRow,
  stored: StoredDavBody,
) {
  if (!matchesDavObject(row, stored.object) || !/^[a-f0-9]{64}$/.test(stored.sha256))
    throw new Error("dav_put_write_failed");
  const proof = source(row),
    admission = await acquireSystemMutation(env, row.owner_id, "dav.put-stored");
  await commitSystemMutation(env.DB, admission, row.owner_id, [
    assertExists(
      proof.sql +
        " AND u.state='receiving' AND u.in_flight=1 AND r.state='reserved' AND b.state='staging' AND o.state IN ('claimed','failed')",
      proof.values,
    ),
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
      values: [row.blob_id, row.declared_size, stored.object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [row.blob_id, row.declared_size, stored.object.etag],
    ),
    {
      sql: "UPDATE blobs SET sha256_verified=?,r2_etag=? WHERE id=? AND state='staging'",
      values: [stored.sha256, stored.object.etag, row.blob_id],
    },
    assertOneChange,
    {
      sql: `UPDATE uploads SET state='completing',in_flight=0,accept_parts=0,last_progress_at=MAX(last_progress_at,${CLOCK}) WHERE id=? AND state='receiving'`,
      values: [row.id],
    },
    assertOneChange,
  ]);
}

export function davPublicationFence(row: DavUploadRow, stored: StoredDavBody): SqlStatement {
  const proof = source(row);
  return assertExists(
    proof.sql +
      ` AND u.state='completing' AND u.in_flight=0 AND u.accept_parts=0
    AND r.state='reserved' AND b.state='staging' AND o.state='claimed' AND b.sha256_verified=? AND b.r2_etag=?
    AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL)`,
    [...proof.values!, stored.sha256, stored.object.etag],
  );
}

/** Known failed publication releases only the logical reservation, never deletes/refunds R2. */
export async function settleFailedDavUpload(env: SystemMutationSource, row: DavUploadRow) {
  // Unknown bodies remain held until the durable 24h cleanup; a failed operation is not an R2 proof.
  if (!["completing", "failed"].includes(row.state)) return;
  const proof = source(row);
  const settled = () =>
    prepare(primary(env.DB), {
      ...proof,
      sql:
        proof.sql +
        " AND o.state='failed' AND u.state='failed' AND u.in_flight=0 AND r.state='released' AND b.state IN ('orphan','deleted')",
    }).first();
  if (await settled()) return;
  const admission = await acquireSystemMutation(env, row.owner_id, "dav.put-failed");
  try {
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      assertExists(
        proof.sql +
          ` AND o.state='failed' AND u.state IN ('completing','failed') AND u.in_flight=0 AND u.accept_parts=0
          AND u.cleanup_token IS NULL AND r.state='reserved' AND b.state IN ('staging','orphan') AND b.sha256_verified IS NOT NULL
        AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL)`,
        proof.values,
      ),
      {
        sql: "UPDATE uploads SET state='failed',cleanup_pending=1,error_code='complete_failed' WHERE id=?",
        values: [row.id],
      },
      assertOneChange,
      { sql: "UPDATE blobs SET state='orphan' WHERE id=? AND ref_count=0", values: [row.blob_id] },
      assertOneChange,
      {
        sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
        values: [row.reservation_id],
      },
      assertOneChange,
      {
        sql: `INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
        values: [row.blob_id],
      },
      assertExists("SELECT 1 FROM gc_candidates WHERE blob_id=? AND state='candidate'", [
        row.blob_id,
      ]),
    ]);
  } catch (error) {
    if (!(await settled())) throw error;
  }
}
