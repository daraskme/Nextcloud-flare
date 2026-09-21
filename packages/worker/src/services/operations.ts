import type { Env } from "../env.js";

export interface OperationClaim {
  operationId: string;
  permitId: string;
  spaceId: string;
  userId: string;
  sessionId: string;
  credentialKind?: "access" | "app_password";
  credentialId?: string;
  appPasswordId?: string;
  epoch: number;
  kind: string;
  requestDigest: string;
  expectedSteps: number;
  permitExpiresAt: number;
}

export async function claimOperation(env: Env, claim: OperationClaim): Promise<void> {
  const now = Date.now();
  const appPassword = claim.credentialKind === "app_password";
  const credentialGuard = appPassword
    ? env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM app_passwords ap JOIN sessions s ON s.id=ap.session_id AND s.user_id=ap.user_id JOIN users u ON u.id=ap.user_id WHERE ap.id=?1 AND ap.user_id=?2 AND ap.session_id=?3 AND ap.revoked_at IS NULL AND ap.expires_at>(strftime('%s','now')*1000) AND s.kind='app_password' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
      ).bind(claim.appPasswordId ?? "", claim.userId, claim.sessionId)
    : env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.kind='access' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
      ).bind(claim.sessionId, claim.userId);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits p JOIN control c ON c.singleton=1 WHERE p.permit_id=?1 AND p.state='open' AND p.epoch=?2 AND p.space_id=?3 AND p.expires_at>(strftime('%s','now')*1000) AND c.epoch=?2)",
    ).bind(claim.permitId, claim.epoch, claim.spaceId),
    credentialGuard,
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES(?1,?2,?3,?4,NULL,?5,?6,'claimed',?7,?8,?9,?10,?10,?11,NULL,NULL,?12,?12)",
    ).bind(
      claim.operationId,
      appPassword ? "app_password" : "user",
      claim.userId,
      claim.credentialId ?? `as:${claim.sessionId}`,
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
