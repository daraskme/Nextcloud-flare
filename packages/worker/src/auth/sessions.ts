import type { Env } from "../env.js";

export interface AccessSessionClaims {
  issuer: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AccessSession {
  id: string;
  credentialId: string;
  fingerprint: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `as_${base64Url(bytes)}`;
}

export async function accessSessionFingerprint(claims: AccessSessionClaims): Promise<string> {
  if (
    !Number.isInteger(claims.issuedAt) ||
    !Number.isInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > 86_400
  ) {
    throw new RangeError("Access session timestamps are invalid");
  }
  const input = new TextEncoder().encode(
    `${claims.issuer}|${claims.subject}|${claims.issuedAt}|${claims.expiresAt}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return base64Url(new Uint8Array(digest));
}

export async function getOrCreateAccessSession(
  env: Env,
  userId: string,
  claims: AccessSessionClaims,
  now = Date.now(),
): Promise<AccessSession> {
  const fingerprint = await accessSessionFingerprint(claims);
  const existing = await env.DB.prepare(
    "SELECT id FROM sessions WHERE fingerprint=?1 AND user_id=?2 AND kind='access' AND revoked_at IS NULL AND expires_at>?3",
  )
    .bind(fingerprint, userId, now)
    .first<{ id: string }>();
  if (existing !== null) {
    return { id: existing.id, credentialId: `as:${existing.id}`, fingerprint };
  }

  const id = randomId();
  const expiresAt = claims.expiresAt * 1000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)",
    ).bind(userId),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES(?1,?2,'access',?3,?4,?5,NULL,?6)",
    ).bind(id, userId, fingerprint, claims.issuedAt * 1000, expiresAt, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return { id, credentialId: `as:${id}`, fingerprint };
}

export async function logoutAccessSession(
  env: Env,
  sessionId: string,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sessions SET revoked_at=?1,last_seen_at=?1 WHERE id=?2 AND user_id=?3 AND kind='access' AND revoked_at IS NULL",
    ).bind(now, sessionId, userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE content_sessions SET revoked_at=?1 WHERE issued_by_credential_id=?2 AND revoked_at IS NULL",
    ).bind(now, sessionId),
  ]);
}

export async function isLiveJobCredential(
  env: Env,
  jobId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 live FROM job_leases j JOIN sessions s ON s.id=j.credential_id JOIN users u ON u.id=s.user_id WHERE j.job_id=?1 AND j.state='claimed' AND j.claim_expires_at>?2 AND s.revoked_at IS NULL AND s.expires_at>?2 AND u.disabled_at IS NULL",
  )
    .bind(jobId, now)
    .first<{ live: number }>();
  return row?.live === 1;
}
