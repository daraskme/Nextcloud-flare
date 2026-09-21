import type { Env } from "../env.js";

export interface UserMutationContext {
  operationId: string;
  permitId: string;
  epoch: number;
  userId: string;
  sessionId: string;
  credentialKind?: "access" | "app_password";
  credentialId?: string;
  appPasswordId?: string;
  spaceId: string;
  auditId: string;
  outboxId: string;
}

export function mutationGuards(env: Env, input: UserMutationContext): D1PreparedStatement[] {
  const appPassword = input.credentialKind === "app_password";
  const credentialGuard = appPassword
    ? env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id JOIN app_passwords ap ON ap.session_id=s.id AND ap.user_id=u.id JOIN operations o ON o.op_id=?1 WHERE u.id=?2 AND u.disabled_at IS NULL AND s.id=?3 AND s.kind='app_password' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND ap.id=?4 AND ap.revoked_at IS NULL AND ap.expires_at>(strftime('%s','now')*1000) AND o.principal_kind='app_password' AND o.credential_id=ap.id)",
      ).bind(input.operationId, input.userId, input.sessionId, input.appPasswordId ?? "")
    : env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id JOIN operations o ON o.op_id=?1 WHERE u.id=?2 AND u.disabled_at IS NULL AND s.id=?3 AND s.kind='access' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND o.principal_kind='user' AND o.credential_id=?4)",
      ).bind(
        input.operationId,
        input.userId,
        input.sessionId,
        input.credentialId ?? `as:${input.sessionId}`,
      );
  return [
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits p JOIN operations o ON o.permit_id=p.permit_id JOIN control c ON c.singleton=1 WHERE p.permit_id=?1 AND p.state='open' AND p.epoch=?2 AND p.space_id=?3 AND p.expires_at>(strftime('%s','now')*1000) AND o.op_id=?4 AND o.state='claimed' AND o.epoch=?2 AND o.space_id=?3 AND o.claimed_expires_at=p.expires_at AND c.epoch=?2)",
    ).bind(input.permitId, input.epoch, input.spaceId, input.operationId),
    credentialGuard,
  ];
}

export function assertChanged(env: Env, count = 1): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?1").bind(count);
}

export function operationStep(
  env: Env,
  operationId: string,
  step: number,
  kind: string,
  affectedId: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?1,?2,?3,?4)",
    ).bind(operationId, step, kind, affectedId),
    assertChanged(env),
  ];
}

export function finishMutation(
  env: Env,
  input: UserMutationContext,
  result: unknown,
  now: number,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "UPDATE operations SET state='committed',result_json=?1,updated_at=?2 WHERE op_id=?3 AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?3)=expected_steps",
    ).bind(JSON.stringify(result), now, input.operationId),
    assertChanged(env),
  ];
}

export function auditAndOutbox(
  env: Env,
  input: UserMutationContext,
  kind: string,
  targetId: string,
  step: number,
  now: number,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "INSERT INTO audit(audit_id,op_id,actor_id,kind,target_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
    ).bind(input.auditId, input.operationId, input.userId, kind, targetId, now),
    assertChanged(env),
    ...operationStep(env, input.operationId, step, "audit.insert", input.auditId),
    env.DB.prepare(
      "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,dispatch_token,dispatch_expires_at,epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,'pending',NULL,NULL,?5,?6,?6)",
    ).bind(input.outboxId, input.operationId, kind, targetId, input.epoch, now),
    assertChanged(env),
    env.DB.prepare(
      "INSERT INTO media_jobs(id,node_id,blob_id,owner_id,variant,generator_version,saved_principal_json,epoch,state,attempt,claim_token,claim_expires_at,last_error,created_at,updated_at) SELECT ?1,n.id,n.current_blob_id,n.owner_id,'metadata','image-v1',?2,?3,'pending',0,NULL,NULL,NULL,?4,?4 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?5 AND n.owner_id=?6 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND b.size<=20000000 AND lower(COALESCE(b.mime_sniffed,'')) LIKE 'image/%' AND lower(COALESCE(b.mime_sniffed,''))<>'image/svg+xml' ON CONFLICT(node_id,blob_id,variant,generator_version) DO NOTHING",
    ).bind(
      `media_${crypto.randomUUID().replaceAll("-", "")}`,
      JSON.stringify({
        kind: input.credentialKind === "app_password" ? "app_password" : "user",
        userId: input.userId,
        credentialId: input.credentialId ?? `as:${input.sessionId}`,
      }),
      input.epoch,
      now,
      targetId,
      input.userId,
    ),
    env.DB.prepare(
      "INSERT INTO library_items(id,node_id,blob_id,kind,title,author,cover_blob_id,generator_version,series,tags_json,page_count,cover_key,status,error_code,metadata_json,override_json,updated_at) SELECT ?1,n.id,n.current_blob_id,CASE WHEN lower(n.name) LIKE '%.epub' THEN 'epub' WHEN lower(n.name) LIKE '%.pdf' THEN 'pdf' ELSE 'cbz' END,CASE WHEN instr(n.name,'.')>1 THEN substr(n.name,1,length(n.name)-length(substr(n.name,instr(n.name,'.')))) ELSE n.name END,NULL,NULL,'library-v1',NULL,'[]',NULL,NULL,'pending',NULL,'{}','{}',?2 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?3 AND n.owner_id=?4 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND (lower(n.name) LIKE '%.cbz' OR lower(n.name) LIKE '%.zip' OR lower(n.name) LIKE '%.epub' OR lower(n.name) LIKE '%.pdf' OR lower(n.name) LIKE '%.cbr' OR lower(n.name) LIKE '%.rar' OR lower(n.name) LIKE '%.7z') AND EXISTS(WITH RECURSIVE a(id,parent_id,owner_id,depth) AS (SELECT n.id,n.parent_id,n.owner_id,0 UNION ALL SELECT p.id,p.parent_id,p.owner_id,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL) SELECT 1 FROM a JOIN library_roots r ON r.node_id=a.id AND r.user_id=a.owner_id) ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,kind=excluded.kind,title=excluded.title,generator_version=excluded.generator_version,page_count=NULL,cover_key=NULL,status='pending',error_code=NULL,metadata_json='{}',updated_at=excluded.updated_at",
    ).bind(`item_${crypto.randomUUID().replaceAll("-", "")}`, now, targetId, input.userId),
    env.DB.prepare(
      "INSERT INTO library_jobs(id,node_id,blob_id,owner_id,kind,generator_version,saved_principal_json,epoch,state,attempt,claim_token,claim_expires_at,last_error,created_at,updated_at) SELECT ?1,n.id,n.current_blob_id,n.owner_id,CASE WHEN lower(n.name) LIKE '%.epub' THEN 'epub' WHEN lower(n.name) LIKE '%.pdf' THEN 'pdf' ELSE 'archive' END,'library-v1',?2,?3,'pending',0,NULL,NULL,NULL,?4,?4 FROM nodes n JOIN library_items i ON i.node_id=n.id AND i.blob_id=n.current_blob_id WHERE n.id=?5 AND n.owner_id=?6 AND n.kind='file' AND n.deleted_at IS NULL ON CONFLICT(node_id,blob_id,generator_version) DO NOTHING",
    ).bind(
      `library_${crypto.randomUUID().replaceAll("-", "")}`,
      JSON.stringify({
        kind: input.credentialKind === "app_password" ? "app_password" : "user",
        userId: input.userId,
        credentialId: input.credentialId ?? `as:${input.sessionId}`,
      }),
      input.epoch,
      now,
      targetId,
      input.userId,
    ),
    ...operationStep(env, input.operationId, step + 1, "outbox.insert", input.outboxId),
  ];
}
