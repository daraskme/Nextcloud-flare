import type { AuthenticatedShare } from "../auth/share.js";
import { randomToken, sha256 } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { upsertSearchStatements } from "../search/sync.js";
import { immutableBlobKey, markStagedBlobOrphan, transferImmutableBlob } from "./blobs.js";
import { normalizePortableName } from "./fsMutation.js";
import { assertChanged, operationStep } from "./mutation.js";
import { UPLOAD_PART_SIZE, UPLOAD_TTL_MS, uploadStub } from "./uploads/common.js";

interface ShareUploadRow {
  id: string;
  ownerId: string;
  credentialId: string;
  parentId: string;
  blobId: string;
  state: "created" | "receiving" | "completing" | "completed" | "failed" | "aborted" | "expired";
  declaredSize: number;
  reservedBytes: number;
  expiresAt: number;
  epoch: number;
  name: string;
  nameCi: string;
  uploadedSize: number;
  shareId: string;
  shareVersion: number;
}

function receipt(id: string, shareId: string): { receipt_id: string; status_url: string } {
  return {
    receipt_id: id,
    status_url: `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(id)}`,
  };
}

function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { base: name.slice(0, dot), extension: name.slice(dot) }
    : { base: name, extension: "" };
}

async function availableName(
  env: Env,
  parentId: string,
  requested: string,
): Promise<{ name: string; nameCi: string }> {
  const normalized = normalizePortableName(requested);
  const existing = await env.DB.prepare(
    "SELECT 1 found FROM nodes WHERE parent_id=?1 AND name_ci=?2 AND deleted_at IS NULL",
  )
    .bind(parentId, normalized.nameCi)
    .first<{ found: number }>();
  if (existing === null) return normalized;
  const parts = splitName(normalized.name);
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = normalizePortableName(`${parts.base} (upload ${index})${parts.extension}`);
    const conflict = await env.DB.prepare(
      "SELECT 1 found FROM nodes WHERE parent_id=?1 AND name_ci=?2 AND deleted_at IS NULL",
    )
      .bind(parentId, candidate.nameCi)
      .first<{ found: number }>();
    if (conflict === null) return candidate;
  }
  throw new Error("name_conflict");
}

async function loadUpload(
  env: Env,
  authentication: AuthenticatedShare,
  uploadId: string,
): Promise<ShareUploadRow> {
  const row = await env.DB.prepare(
    "SELECT u.id,u.owner_id ownerId,u.credential_id credentialId,u.parent_id parentId,u.blob_id blobId,u.state,u.declared_size declaredSize,u.reserved_bytes reservedBytes,u.expires_at expiresAt,u.epoch,u.target_name name,u.target_name_ci nameCi,u.uploaded_size uploadedSize,u.share_id shareId,u.share_version shareVersion FROM uploads u JOIN shares s ON s.id=u.share_id JOIN share_sessions ss ON ss.id=?1 AND ss.share_id=s.id WHERE u.id=?2 AND u.credential_id=?3 AND u.share_id=?4 AND u.share_version=?5 AND u.mode='single' AND u.expires_at>?6 AND s.version=u.share_version AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?6) AND ss.share_version=s.version AND ss.revoked_at IS NULL AND ss.expires_at>?6",
  )
    .bind(
      authentication.sessionId,
      uploadId,
      authentication.principal.credentialId,
      authentication.share.id,
      authentication.share.version,
      Date.now(),
    )
    .first<ShareUploadRow>();
  if (row === null) throw new Error("upload_not_found");
  return row;
}

export async function createShareUpload(
  env: Env,
  authentication: AuthenticatedShare,
  input: { name: string; declaredSize: number; mode: "single" | "multipart" },
): Promise<{ receipt_id: string; status_url: string }> {
  if (!authentication.share.actions.includes("upload")) throw new Error("share_action_forbidden");
  if (
    input.mode !== "single" ||
    !Number.isSafeInteger(input.declaredSize) ||
    input.declaredSize < 0 ||
    input.declaredSize > 95_000_000
  ) {
    throw new RangeError("Public uploads must use a bounded single request");
  }
  const parent = await env.DB.prepare(
    "SELECT n.kind,n.revision,n.space_id spaceId,s.tree_generation treeGeneration FROM nodes n JOIN spaces s ON s.id=n.space_id WHERE n.id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL",
  )
    .bind(authentication.share.rootNodeId, authentication.share.ownerId)
    .first<{ kind: string; revision: number; spaceId: string; treeGeneration: number }>();
  if (parent === null || (parent.kind !== "root" && parent.kind !== "folder")) {
    throw new Error("not_a_folder");
  }
  const name = await availableName(env, authentication.share.rootNodeId, input.name);
  const uploadId = `upl_${randomToken(18)}`;
  const blobId = `blob_${randomToken(18)}`;
  const now = Date.now();
  const expiresAt = now + UPLOAD_TTL_MS;
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares s JOIN share_sessions ss ON ss.share_id=s.id JOIN sessions se ON se.id=ss.id JOIN users u ON u.id=s.owner_id WHERE s.id=?1 AND s.version=?2 AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?3) AND EXISTS(SELECT 1 FROM json_each(s.actions_json) WHERE value='upload') AND ss.id=?4 AND ss.share_version=s.version AND ss.revoked_at IS NULL AND ss.expires_at>?3 AND se.revoked_at IS NULL AND se.expires_at>?3 AND u.disabled_at IS NULL)",
    ).bind(authentication.share.id, authentication.share.version, now, authentication.sessionId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes+?1 WHERE id=?2 AND disabled_at IS NULL AND used_bytes+reserved_bytes+?1<=quota_bytes AND (physical_bytes+reserved_bytes+?1)*10<=quota_bytes*12",
    ).bind(input.declaredSize, authentication.share.ownerId),
    assertChanged(env),
    env.DB.prepare(
      "INSERT INTO uploads(id,owner_id,credential_id,parent_id,target_node_id,blob_id,mode,state,declared_size,reserved_bytes,expires_at,epoch,created_at,updated_at,target_name,target_name_ci,capability_digest,part_size,uploaded_size,share_id,share_version) VALUES(?1,?2,?3,?4,NULL,?5,'single','created',?6,?6,?7,?8,?9,?9,?10,?11,'',?12,0,?13,?14)",
    ).bind(
      uploadId,
      authentication.share.ownerId,
      authentication.principal.credentialId,
      authentication.share.rootNodeId,
      blobId,
      input.declaredSize,
      expiresAt,
      control.epoch,
      now,
      name.name,
      name.nameCi,
      UPLOAD_PART_SIZE,
      authentication.share.id,
      authentication.share.version,
    ),
    assertChanged(env),
  ]);
  const initialized = await uploadStub(env, uploadId).fetch("https://upload.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uploadId,
      mode: "single",
      declaredSize: input.declaredSize,
      partSize: UPLOAD_PART_SIZE,
    }),
  });
  if (!initialized.ok) throw new Error("upload_state_unavailable");
  return receipt(uploadId, authentication.share.id);
}

export async function getShareUploadStatus(
  env: Env,
  authentication: AuthenticatedShare,
  uploadId: string,
): Promise<{ receipt_id: string; status_url: string; status: string }> {
  const upload = await loadUpload(env, authentication, uploadId);
  return { ...receipt(upload.id, authentication.share.id), status: upload.state };
}

export async function putShareUpload(
  env: Env,
  authentication: AuthenticatedShare,
  uploadId: string,
  source: ReadableStream<Uint8Array>,
  size: number,
): Promise<{ receipt_id: string; status_url: string }> {
  const upload = await loadUpload(env, authentication, uploadId);
  if (upload.state !== "created" || size !== upload.declaredSize) {
    throw new Error("upload_size_mismatch");
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET state='receiving',updated_at=?1 WHERE id=?2 AND state='created' AND epoch=(SELECT epoch FROM control WHERE singleton=1)",
    ).bind(Date.now(), upload.id),
    assertChanged(env),
  ]);
  const started = await uploadStub(env, upload.id).fetch("https://upload.internal/single/start", {
    method: "POST",
  });
  if (!started.ok) throw new Error("single_put_forbidden");
  const blob = await transferImmutableBlob(env, {
    ownerId: upload.ownerId,
    blobId: upload.blobId,
    source,
    size,
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET uploaded_size=?1,r2_etag=?2,updated_at=?3 WHERE id=?4 AND state='receiving' AND uploaded_size=0",
    ).bind(size, blob.r2Etag, Date.now(), upload.id),
    assertChanged(env),
  ]);
  return receipt(upload.id, authentication.share.id);
}

async function claimShareOperation(
  env: Env,
  authentication: AuthenticatedShare,
  upload: ShareUploadRow,
  spaceId: string,
): Promise<{
  operationId: string;
  permitId: string;
  auditId: string;
  outboxId: string;
  release: (action: "release" | "revoke") => Promise<void>;
}> {
  const operationId = `op_${randomToken(18)}`;
  const permitId = `pmt_${randomToken(18)}`;
  const auditId = `aud_${randomToken(18)}`;
  const outboxId = `out_${randomToken(18)}`;
  const lock = env.LOCKS.get(env.LOCKS.idFromName(spaceId));
  const permitResponse = await lock.fetch("https://lock.internal/permits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permitId,
      spaceId,
      epoch: upload.epoch,
      ttlMs: 30_000,
      nodeIds: [upload.parentId],
    }),
  });
  if (!permitResponse.ok)
    throw new Error(permitResponse.status === 423 ? "locked" : "permit_denied");
  const permit: { expires_at: number } = await permitResponse.json();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares s JOIN share_sessions ss ON ss.share_id=s.id JOIN sessions se ON se.id=ss.id WHERE s.id=?1 AND s.version=?2 AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?3) AND EXISTS(SELECT 1 FROM json_each(s.actions_json) WHERE value='upload') AND ss.id=?4 AND ss.share_version=s.version AND ss.revoked_at IS NULL AND ss.expires_at>?3 AND se.revoked_at IS NULL AND se.expires_at>?3)",
    ).bind(authentication.share.id, authentication.share.version, now, authentication.sessionId),
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES(?1,'share',?2,?3,?4,?5,'node.create','claimed',?6,?7,?8,?9,?9,7,NULL,NULL,?10,?10)",
    ).bind(
      operationId,
      authentication.share.id,
      authentication.principal.credentialId,
      authentication.share.version,
      spaceId,
      await sha256(upload.id),
      upload.epoch,
      permitId,
      permit.expires_at,
      now,
    ),
    assertChanged(env),
  ]);
  return {
    operationId,
    permitId,
    auditId,
    outboxId,
    release: async (action) => {
      await lock.fetch(`https://lock.internal/permits/${permitId}/${action}`, { method: "POST" });
    },
  };
}

export async function completeShareUpload(
  env: Env,
  authentication: AuthenticatedShare,
  uploadId: string,
): Promise<{ receipt_id: string; status_url: string }> {
  let upload = await loadUpload(env, authentication, uploadId);
  if (upload.state === "completed") return receipt(upload.id, authentication.share.id);
  if (upload.state !== "receiving" && upload.state !== "completing") {
    throw new Error("upload_complete_forbidden");
  }
  const object = await env.BLOBS.head(immutableBlobKey(upload.ownerId, upload.blobId));
  if (
    object === null ||
    object.size !== upload.declaredSize ||
    upload.uploadedSize !== upload.declaredSize
  ) {
    throw new Error("upload_object_inconsistent");
  }
  if (upload.state === "receiving") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE uploads SET state='completing',updated_at=?1 WHERE id=?2 AND state='receiving' AND uploaded_size=declared_size",
      ).bind(Date.now(), upload.id),
      assertChanged(env),
    ]);
    upload = { ...upload, state: "completing" };
  }
  const parent = await env.DB.prepare(
    "SELECT n.revision,n.space_id spaceId,s.tree_generation treeGeneration FROM nodes n JOIN spaces s ON s.id=n.space_id WHERE n.id=?1 AND n.owner_id=?2 AND n.kind IN ('root','folder') AND n.deleted_at IS NULL",
  )
    .bind(upload.parentId, upload.ownerId)
    .first<{ revision: number; spaceId: string; treeGeneration: number }>();
  if (parent === null) throw new Error("node_not_found");
  const name = await availableName(env, upload.parentId, upload.name);
  const nodeId = `nod_${randomToken(18)}`;
  const lease = await claimShareOperation(env, authentication, upload, parent.spaceId);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits p JOIN operations o ON o.permit_id=p.permit_id JOIN control c ON c.singleton=1 JOIN shares s ON s.id=?1 JOIN share_sessions ss ON ss.share_id=s.id JOIN sessions se ON se.id=ss.id WHERE p.permit_id=?2 AND p.state='open' AND p.epoch=?3 AND p.space_id=?4 AND p.expires_at>(strftime('%s','now')*1000) AND o.op_id=?5 AND o.state='claimed' AND o.epoch=?3 AND c.epoch=?3 AND s.version=?6 AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>(strftime('%s','now')*1000)) AND EXISTS(SELECT 1 FROM json_each(s.actions_json) WHERE value='upload') AND ss.id=?7 AND ss.share_version=s.version AND ss.revoked_at IS NULL AND ss.expires_at>(strftime('%s','now')*1000) AND se.revoked_at IS NULL AND se.expires_at>(strftime('%s','now')*1000))",
      ).bind(
        authentication.share.id,
        lease.permitId,
        upload.epoch,
        parent.spaceId,
        lease.operationId,
        authentication.share.version,
        authentication.sessionId,
      ),
      env.DB.prepare(
        "UPDATE blobs SET state='committed',ref_count=1,last_op_id=?1 WHERE id=?2 AND owner_id=?3 AND state='staging' AND ref_count=0",
      ).bind(lease.operationId, upload.blobId, upload.ownerId),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 1, "blob.commit", upload.blobId),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES(?1,?2,?3,?4,?5,?6,'file',?7,1,NULL,?8,?8,NULL,NULL,NULL,0,?9)",
      ).bind(
        nodeId,
        parent.spaceId,
        upload.ownerId,
        upload.parentId,
        name.name,
        name.nameCi,
        upload.blobId,
        now,
        lease.operationId,
      ),
      assertChanged(env),
      ...upsertSearchStatements(env, {
        nodeId,
        spaceId: parent.spaceId,
        text: name.name,
        revision: 1,
      }),
      ...operationStep(env, lease.operationId, 2, "node.insert", nodeId),
      env.DB.prepare(
        "UPDATE users SET reserved_bytes=reserved_bytes-?1,used_bytes=used_bytes+?1 WHERE id=?2 AND reserved_bytes>=?1",
      ).bind(upload.declaredSize, upload.ownerId),
      assertChanged(env),
      env.DB.prepare(
        "UPDATE uploads SET state='completed',target_node_id=?1,target_name=?2,target_name_ci=?3,updated_at=?4 WHERE id=?5 AND state='completing' AND share_id=?6 AND share_version=?7",
      ).bind(
        nodeId,
        name.name,
        name.nameCi,
        now,
        upload.id,
        authentication.share.id,
        authentication.share.version,
      ),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 3, "quota.upload.commit", upload.id),
      env.DB.prepare(
        "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
      ).bind(now, lease.operationId, upload.parentId, parent.revision),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 4, "parent.revision", upload.parentId),
      env.DB.prepare(
        "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
      ).bind(parent.spaceId, upload.ownerId, parent.treeGeneration),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 5, "space.generation", parent.spaceId),
      env.DB.prepare(
        "INSERT INTO audit(audit_id,op_id,actor_id,kind,target_id,created_at) VALUES(?1,?2,?3,'share.upload',?4,?5)",
      ).bind(lease.auditId, lease.operationId, authentication.share.id, nodeId, now),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 6, "audit.insert", lease.auditId),
      env.DB.prepare(
        "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,dispatch_token,dispatch_expires_at,epoch,created_at,updated_at) VALUES(?1,?2,'node.created',?3,'pending',NULL,NULL,?4,?5,?5)",
      ).bind(lease.outboxId, lease.operationId, nodeId, upload.epoch, now),
      assertChanged(env),
      ...operationStep(env, lease.operationId, 7, "outbox.insert", lease.outboxId),
      env.DB.prepare(
        "UPDATE operations SET state='committed',result_json=?1,updated_at=?2 WHERE op_id=?3 AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?3)=expected_steps",
      ).bind(JSON.stringify({ receipt_id: upload.id }), now, lease.operationId),
      assertChanged(env),
    ]);
    await lease.release("release");
    await uploadStub(env, upload.id).fetch("https://upload.internal/completed", { method: "POST" });
    return receipt(upload.id, authentication.share.id);
  } catch (error) {
    await lease.release("revoke").catch(() => undefined);
    throw error;
  }
}

export async function abortShareUpload(
  env: Env,
  authentication: AuthenticatedShare,
  uploadId: string,
): Promise<void> {
  const upload = await loadUpload(env, authentication, uploadId);
  if (upload.state === "completing" || upload.state === "completed") {
    throw new Error("completing_abort_forbidden");
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET state='aborted',updated_at=?1 WHERE id=?2 AND state IN ('created','receiving')",
    ).bind(Date.now(), upload.id),
    assertChanged(env),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-?1 WHERE id=?2 AND reserved_bytes>=?1",
    ).bind(upload.reservedBytes, upload.ownerId),
    assertChanged(env),
  ]);
  if (upload.state === "receiving") {
    await markStagedBlobOrphan(env, upload.blobId, upload.ownerId).catch(() => undefined);
  }
  await uploadStub(env, upload.id).fetch("https://upload.internal/aborted", { method: "POST" });
}
