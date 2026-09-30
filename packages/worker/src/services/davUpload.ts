import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertCreateLocks } from "../auth/locks";
import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  prepare,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { OperationIntent } from "../jobs/operations";
import {
  type AccountMutationEnv,
  accountMutationStatements,
  acquireAccountMutation,
} from "./accountMutation";
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
  completion_op_id: string | null;
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
    .prepare(
      "SELECT * FROM uploads WHERE id=? AND source='dav' AND (completion_op_id IS NULL OR completion_op_id=?)",
    )
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
  env: AccountMutationEnv,
  intent: OperationIntent,
  authorized: AuthorizedNode,
  request: PutFileRequest,
  owner: string,
  hashes: readonly string[],
): Promise<DavUploadRow> {
  const now = Date.now(),
    op = intent.id;
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
    epoch: intent.principal.epoch,
    declared_size: request.size,
    request_digest: intent.digest,
    completion_op_id: null,
    write_attempt_id: crypto.randomUUID(),
    write_lease_expires_at: now + 900_000,
    expires_at: now + 86_400_000,
    state: "receiving",
  };
  const admission = await acquireAccountMutation(env, owner, row.epoch, "dav.put-start");
  await atomicBatch(
    env.DB,
    accountMutationStatements(admission, owner, [
      authorizationAssertion(authorized),
      assertCreateLocks(
        request.nodeId ?? request.parentId,
        request.spaceId,
        request.principal,
        hashes,
      ),
      assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM uploads WHERE id=?)", [row.id]),
      assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operations WHERE op_id=?)", [op]),
      ...reservationStatements({
        id: row.reservation_id,
        ownerId: owner,
        bytes: request.size,
        expiresAt: row.expires_at,
        epoch: row.epoch,
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
          null,
          row.write_attempt_id,
          row.write_lease_expires_at,
          now,
          row.expires_at,
          now,
          request.size,
        ],
      },
      assertOneChange,
    ]),
  );
  return row;
}

/** Bind saved facts to the original attempt and DAV operation, never to the caller's current owner. */
function source(row: DavUploadRow): SqlStatement {
  return {
    sql: `SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
    JOIN blobs b ON b.id=u.blob_id LEFT JOIN operations o ON u.id='dav_'||o.op_id
    JOIN spaces space ON space.id=u.space_id AND space.owner_id=u.owner_id JOIN control c ON c.singleton=1
    WHERE (u.id=? AND u.source='dav' AND u.owner_id=? AND u.space_id=? AND u.parent_id=? AND u.target_id IS ?
      AND u.target_revision IS ? AND u.blob_id=? AND u.reservation_id=? AND u.credential_id=? AND u.epoch=?)
      AND (u.declared_size=? AND u.request_digest=? AND u.completion_op_id IS ? AND u.write_attempt_id=?
      AND u.write_lease_expires_at=? AND u.expires_at=? AND u.mode='single' AND c.epoch=u.epoch)
      AND (r.owner_id=u.owner_id AND r.bytes=u.declared_size AND r.epoch=u.epoch AND r.expires_at=u.expires_at
      AND r.share_id IS NULL AND r.op_id IS u.completion_op_id)
      AND (b.owner_id=u.owner_id AND b.size=u.declared_size AND b.ref_count=0
      AND b.r2_key='u/'||u.owner_id||'/b/'||u.blob_id)
      AND ((o.op_id IS NULL AND u.completion_op_id IS NULL) OR
      (o.kind='dav.put' AND o.principal_kind='app_password' AND o.credential_id=u.credential_id
      AND o.epoch=u.epoch AND o.space_id=u.space_id AND o.request_digest=u.request_digest
      AND (u.completion_op_id IS NULL OR u.completion_op_id=o.op_id)
      AND json_extract(o.operands_json,'$.parentId')=u.parent_id
      AND json_extract(o.operands_json,'$.nodeId') IS u.target_id))
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
        " AND u.state='receiving' AND u.in_flight=1 AND r.state='reserved' AND b.state='staging' AND (o.op_id IS NULL OR o.state IN ('claimed','failed'))",
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

export function davPublicationStatements(row: DavUploadRow, stored: StoredDavBody): SqlStatement[] {
  const proof = source(row);
  const op = row.id.slice(4);
  return [
    assertExists(
      proof.sql +
        ` AND u.state='completing' AND u.in_flight=0 AND u.accept_parts=0 AND u.cleanup_token IS NULL AND u.expires_at>${CLOCK}
    AND r.state='reserved' AND b.state='staging' AND o.state='claimed' AND b.sha256_verified=? AND b.r2_etag=?
    AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL)`,
      [...proof.values!, stored.sha256, stored.object.etag],
    ),
    {
      sql: "UPDATE reservations SET op_id=? WHERE id=? AND op_id IS ? AND state='reserved'",
      values: [op, row.reservation_id, row.completion_op_id],
    },
    assertOneChange,
    {
      sql: "UPDATE uploads SET completion_op_id=? WHERE id=? AND completion_op_id IS ? AND state='completing'",
      values: [op, row.id, row.completion_op_id],
    },
    assertOneChange,
  ];
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
        sql: `INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',${GC_NOT_BEFORE_SQL}) ON CONFLICT(blob_id) DO NOTHING`,
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
