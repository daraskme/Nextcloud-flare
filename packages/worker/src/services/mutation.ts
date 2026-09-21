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
    ...operationStep(env, input.operationId, step + 1, "outbox.insert", input.outboxId),
  ];
}
