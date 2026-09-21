import type { Env } from "../env.js";

export interface OperationClaim {
  operationId: string;
  permitId: string;
  spaceId: string;
  userId: string;
  sessionId: string;
  epoch: number;
  kind: string;
  requestDigest: string;
  expectedSteps: number;
  permitExpiresAt: number;
}

export async function claimOperation(env: Env, claim: OperationClaim): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits p JOIN control c ON c.singleton=1 WHERE p.permit_id=?1 AND p.state='open' AND p.epoch=?2 AND p.space_id=?3 AND p.expires_at>(strftime('%s','now')*1000) AND c.epoch=?2)",
    ).bind(claim.permitId, claim.epoch, claim.spaceId),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.kind='access' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
    ).bind(claim.sessionId, claim.userId),
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES(?1,'user',?2,?3,NULL,?4,?5,'claimed',?6,?7,?8,?9,?9,?10,NULL,NULL,?11,?11)",
    ).bind(
      claim.operationId,
      claim.userId,
      `as:${claim.sessionId}`,
      claim.spaceId,
      claim.kind,
      claim.requestDigest,
      claim.epoch,
      claim.permitId,
      claim.permitExpiresAt,
      claim.expectedSteps,
      now,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

export async function lookupOperation(
  env: Env,
  operationId: string,
  credentialId: string,
): Promise<{ state: string; result_json: string | null; error_code: string | null } | null> {
  return env.DB.prepare(
    "SELECT state,result_json,error_code FROM operations WHERE op_id=?1 AND credential_id=?2",
  )
    .bind(operationId, credentialId)
    .first();
}
