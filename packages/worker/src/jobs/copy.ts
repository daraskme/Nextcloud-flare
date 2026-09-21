import { scopes } from "@ncf/shared";

import { acquireMutation } from "../api/mutation.js";
import type { AuthenticatedUser } from "../auth/httpAuth.js";
import type { Env } from "../env.js";
import {
  immutableBlobKey,
  markStagedBlobOrphan,
  recordCompletedBlob,
  transferImmutableBlob,
} from "../services/blobs.js";
import { createFile } from "../services/fileMutations.js";
import { normalizePortableName } from "../services/fsMutation.js";
import { isEffectiveLive } from "../services/effectiveLive.js";
import { getOwnedNode, getOwnerWorkspace } from "../services/nodes.js";
import { randomUploadId } from "../services/uploads/common.js";

export interface CopyJobMessage {
  kind: "cross-owner-copy";
  jobId: string;
}

interface CopyJobRow {
  id: string;
  sourceBlobId: string;
  sourceKey: string;
  sourceSize: number;
  destinationOwnerId: string;
  destinationParentId: string;
  destinationBlobId: string;
  destinationName: string;
  credentialId: string;
  pinId: string;
  declaredSize: number;
  epoch: number;
  claimToken: string | null;
  state: "pending" | "claimed" | "completed" | "failed";
  attempt: number;
}

export async function startCrossOwnerCopy(
  env: Env,
  destinationUser: AuthenticatedUser,
  input: {
    sourceNodeId: string;
    sourceRootId: string;
    destinationParentId: string;
    name?: string;
  },
  send: (message: CopyJobMessage) => Promise<void> = async (message) => {
    await env.JOBS.send(message);
  },
): Promise<string> {
  const source = await env.DB.prepare(
    "SELECT n.name,n.current_blob_id blobId,b.r2_key r2Key,b.size,b.owner_id sourceOwner,s.root_node_id rootId FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN spaces s ON s.id=n.space_id WHERE n.id=?1 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(input.sourceNodeId)
    .first<{
      name: string;
      blobId: string;
      r2Key: string;
      size: number;
      sourceOwner: string;
      rootId: string;
    }>();
  if (
    source === null ||
    source.sourceOwner === destinationUser.principal.userId ||
    source.rootId !== input.sourceRootId ||
    !(await isEffectiveLive(env, input.sourceNodeId, input.sourceRootId))
  ) {
    throw new Error("cross_owner_source_invalid");
  }
  const destination = await getOwnedNode(
    env,
    destinationUser.principal.userId,
    input.destinationParentId,
  );
  if (destination.kind !== "root" && destination.kind !== "folder") throw new Error("not_a_folder");
  const workspace = await getOwnerWorkspace(env, destinationUser.principal.userId);
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const normalized = normalizePortableName(input.name ?? source.name);
  const jobId = randomUploadId("cpy");
  const pinId = randomUploadId("pin");
  const destinationBlobId = randomUploadId("blob");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
    ).bind(destinationUser.principal.sessionId, destinationUser.principal.userId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes+?1 WHERE id=?2 AND disabled_at IS NULL AND used_bytes+reserved_bytes+?1<=quota_bytes AND (physical_bytes+reserved_bytes+?1)*10<=quota_bytes*12",
    ).bind(source.size, destinationUser.principal.userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) SELECT ?1,id,'cross_owner_copy',?2,?3 FROM blobs WHERE id=?4 AND state='committed' AND owner_id=?5",
    ).bind(pinId, now + 24 * 60 * 60 * 1000, now, source.blobId, source.sourceOwner),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare("UPDATE blobs SET ref_count=ref_count+1 WHERE id=?1 AND state='committed'").bind(
      source.blobId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO bulk_jobs(id,kind,source_blob_id,destination_owner_id,destination_parent_id,destination_blob_id,destination_name,destination_name_ci,credential_id,pin_id,declared_size,reserved_bytes,state,attempt,r2_calls,bytes_processed,claim_token,claim_expires_at,epoch,operation_id,last_error,created_at,updated_at) SELECT ?1,'cross_owner_copy',?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,'pending',0,0,0,NULL,NULL,?11,NULL,NULL,?12,?12 WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?4 AND owner_id=?3 AND space_id=?13 AND kind IN ('root','folder') AND deleted_at IS NULL)",
    ).bind(
      jobId,
      source.blobId,
      destinationUser.principal.userId,
      destination.id,
      destinationBlobId,
      normalized.name,
      normalized.nameCi,
      destinationUser.principal.sessionId,
      pinId,
      source.size,
      control.epoch,
      now,
      workspace.spaceId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  await send({ kind: "cross-owner-copy", jobId });
  return jobId;
}

async function claimCopyJob(env: Env, jobId: string): Promise<CopyJobRow | null> {
  const token = randomUploadId("claim");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE bulk_jobs SET state='claimed',attempt=attempt+1,claim_token=?1,claim_expires_at=?2,r2_calls=r2_calls+1,bytes_processed=bytes_processed+declared_size,updated_at=?3 WHERE id=?4 AND kind='cross_owner_copy' AND (state='pending' OR (state='claimed' AND claim_expires_at<=?3)) AND attempt<3 AND r2_calls<20000 AND bytes_processed+declared_size<=declared_size*3 AND epoch=(SELECT epoch FROM control WHERE singleton=1) AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=bulk_jobs.credential_id AND s.user_id=bulk_jobs.destination_owner_id AND s.revoked_at IS NULL AND s.expires_at>?3 AND u.disabled_at IS NULL)",
    ).bind(token, now + 30_000, now, jobId),
  ]);
  return env.DB.prepare(
    "SELECT j.id,j.source_blob_id sourceBlobId,b.r2_key sourceKey,b.size sourceSize,j.destination_owner_id destinationOwnerId,j.destination_parent_id destinationParentId,j.destination_blob_id destinationBlobId,j.destination_name destinationName,j.credential_id credentialId,j.pin_id pinId,j.declared_size declaredSize,j.epoch,j.claim_token claimToken,j.state,j.attempt FROM bulk_jobs j JOIN blobs b ON b.id=j.source_blob_id WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2",
  )
    .bind(jobId, token)
    .first<CopyJobRow>();
}

async function failExhaustedCopyJob(env: Env, jobId: string): Promise<boolean> {
  const now = Date.now();
  const job = await env.DB.prepare(
    "SELECT id,source_blob_id sourceBlobId,destination_owner_id destinationOwnerId,destination_blob_id destinationBlobId,pin_id pinId,reserved_bytes reservedBytes,declared_size declaredSize FROM bulk_jobs WHERE id=?1 AND state='claimed' AND attempt>=3 AND claim_expires_at<=?2",
  )
    .bind(jobId, now)
    .first<{
      id: string;
      sourceBlobId: string;
      destinationOwnerId: string;
      destinationBlobId: string;
      pinId: string;
      reservedBytes: number;
      declaredSize: number;
    }>();
  if (job === null) return false;
  const object = await env.BLOBS.head(
    immutableBlobKey(job.destinationOwnerId, job.destinationBlobId),
  );
  if (object !== null && object.size === job.declaredSize) {
    await recordCompletedBlob(env, {
      id: job.destinationBlobId,
      ownerId: job.destinationOwnerId,
      size: object.size,
      r2Etag: object.httpEtag,
    });
    await markStagedBlobOrphan(env, job.destinationBlobId, job.destinationOwnerId);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blob_pins WHERE pin_id=?1 AND blob_id=?2").bind(
      job.pinId,
      job.sourceBlobId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE blobs SET ref_count=ref_count-1 WHERE id=?1 AND ref_count>0 AND state='committed'",
    ).bind(job.sourceBlobId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-?1 WHERE id=?2 AND reserved_bytes>=?1",
    ).bind(job.reservedBytes, job.destinationOwnerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE bulk_jobs SET state='failed',last_error='attempts_exhausted',claim_token=NULL,claim_expires_at=NULL,updated_at=?1 WHERE id=?2 AND state='claimed' AND attempt>=3",
    ).bind(now, job.id),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return true;
}

async function jobUser(env: Env, job: CopyJobRow): Promise<AuthenticatedUser> {
  const row = await env.DB.prepare(
    "SELECT u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND u.id=?2 AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL",
  )
    .bind(job.credentialId, job.destinationOwnerId)
    .first<{ email: string; role: "member" | "app_admin" }>();
  if (row === null) throw new Error("job_credential_revoked");
  return {
    email: row.email,
    role: row.role,
    principal: {
      kind: "user",
      principalId: job.destinationOwnerId,
      userId: job.destinationOwnerId,
      sessionId: job.credentialId,
      credentialId: `as:${job.credentialId}`,
      scopes: [...scopes],
    },
  };
}

export async function processCrossOwnerCopy(env: Env, jobId: string): Promise<void> {
  const job = await claimCopyJob(env, jobId);
  if (job === null) {
    if (await failExhaustedCopyJob(env, jobId)) return;
    const terminal = await env.DB.prepare("SELECT state FROM bulk_jobs WHERE id=?1")
      .bind(jobId)
      .first<{ state: string }>();
    if (terminal?.state === "completed" || terminal?.state === "failed") return;
    throw new Error("copy_job_not_claimed");
  }
  if (job.claimToken === null || job.sourceSize !== job.declaredSize) {
    throw new Error("copy_job_invalid");
  }
  const destinationKey = immutableBlobKey(job.destinationOwnerId, job.destinationBlobId);
  const existing = await env.BLOBS.head(destinationKey);
  if (existing === null) {
    const source = await env.BLOBS.get(job.sourceKey);
    if (source === null || source.size !== job.declaredSize) throw new Error("copy_source_missing");
    await transferImmutableBlob(env, {
      ownerId: job.destinationOwnerId,
      blobId: job.destinationBlobId,
      source: source.body as unknown as ReadableStream<Uint8Array>,
      size: job.declaredSize,
    });
  } else {
    if (existing.size !== job.declaredSize) throw new Error("copy_destination_mismatch");
    await recordCompletedBlob(env, {
      id: job.destinationBlobId,
      ownerId: job.destinationOwnerId,
      size: existing.size,
      r2Etag: existing.httpEtag,
    });
  }
  const user = await jobUser(env, job);
  const parent = await getOwnedNode(env, user.principal.userId, job.destinationParentId);
  const workspace = await getOwnerWorkspace(env, user.principal.userId);
  const lease = await acquireMutation(env, user, {
    spaceId: workspace.spaceId,
    kind: "node.copy",
    expectedSteps: 7,
    intent: { jobId: job.id, destinationBlobId: job.destinationBlobId },
    nodeIds: [job.destinationParentId],
  });
  try {
    await createFile(env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      parentId: job.destinationParentId,
      expectedParentRevision: parent.revision,
      nodeId: randomUploadId("nod"),
      blobId: job.destinationBlobId,
      name: job.destinationName,
      expectedTreeGeneration: workspace.treeGeneration,
      copyJob: {
        jobId: job.id,
        pinId: job.pinId,
        sourceBlobId: job.sourceBlobId,
        claimToken: job.claimToken,
      },
    });
    await lease.release();
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

export async function dispatchPendingCopyJobs(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM bulk_jobs WHERE state='pending' ORDER BY created_at,id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.JOBS.send({ kind: "cross-owner-copy", jobId: row.id } satisfies CopyJobMessage);
  }
  return rows.results.length;
}
