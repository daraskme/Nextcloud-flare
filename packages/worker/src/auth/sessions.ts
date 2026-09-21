import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

/** Internal claims; the Access verifier and bootstrap checks precede session registration. */
export interface AccessClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
}
export interface AccessSession {
  credential_id: string;
  session_id: string;
  user_id: string;
  role: "member" | "app_admin";
  epoch: number;
  expires_at: number;
}

export async function accessFingerprint(claims: AccessClaims): Promise<string> {
  if (
    !claims.iss ||
    !claims.sub ||
    claims.iss.includes("|") ||
    claims.sub.includes("|") ||
    claims.iss.length > 2048 ||
    claims.sub.length > 1024 ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat < 0 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 86400 ||
    !Number.isSafeInteger(claims.exp * 1000)
  )
    throw new Error("invalid_access_claims");
  const bytes = new TextEncoder().encode(`${claims.iss}|${claims.sub}|${claims.iat}|${claims.exp}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LIVE_ACCESS = `SELECT c.id AS credential_id,s.id AS session_id,u.id AS user_id,u.role,s.epoch,s.expires_at
  FROM credentials c JOIN sessions s ON s.id=c.session_id JOIN users u ON u.id=s.user_id
  JOIN control ctl ON ctl.singleton=1
  WHERE c.id=?1 AND c.kind='access' AND s.kind='access' AND u.disabled_at IS NULL
    AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000)
    AND s.epoch=?2 AND ctl.epoch=?2`;

export function assertLiveAccessCredential(credentialId: string, epoch: number): SqlStatement {
  return assertExists(LIVE_ACCESS, [credentialId, epoch]);
}

export async function readAccessSession(
  db: D1Database,
  credentialId: string,
  epoch: number,
): Promise<AccessSession | null> {
  return primary(db).prepare(LIVE_ACCESS).bind(credentialId, epoch).first<AccessSession>();
}

/** Existing users only: bootstrap/signup and JWT verification are separate prerequisites. */
export async function registerAccessSession(
  db: D1Database,
  claims: AccessClaims,
  epoch: number,
): Promise<AccessSession> {
  const fingerprint = await accessFingerprint(claims);
  const id = crypto.randomUUID();
  await atomicBatch(db, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [epoch]),
    assertExists(
      "SELECT 1 FROM users WHERE access_iss=? AND access_sub=? AND disabled_at IS NULL",
      [claims.iss, claims.sub],
    ),
    {
      sql: `INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at)
        SELECT ?,id,'access',?,?,?, ?,MAX(?,strftime('%s','now')*1000) FROM users WHERE access_iss=? AND access_sub=? AND disabled_at IS NULL
        ON CONFLICT(fingerprint) DO NOTHING`,
      values: [
        id,
        fingerprint,
        epoch,
        claims.iat * 1000,
        claims.exp * 1000,
        claims.iat * 1000,
        claims.iss,
        claims.sub,
      ],
    },
    assertExists(
      `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE fingerprint=? AND s.kind='access'
      AND s.epoch=? AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000)
      AND u.access_iss=? AND u.access_sub=? AND u.disabled_at IS NULL`,
      [fingerprint, epoch, claims.iss, claims.sub],
    ),
    {
      sql: "INSERT INTO credentials(id,kind,session_id) SELECT 'as:'||id,'access',id FROM sessions WHERE fingerprint=? ON CONFLICT(id) DO NOTHING",
      values: [fingerprint],
    },
  ]);
  const credential = await primary(db)
    .prepare(
      "SELECT c.id FROM credentials c JOIN sessions s ON s.id=c.session_id WHERE s.fingerprint=?",
    )
    .bind(fingerprint)
    .first<string>("id");
  const session = credential ? await readAccessSession(db, credential, epoch) : null;
  if (!session) throw new Error("credential_inactive");
  return session;
}

/** Repeated logout is idempotent. R6 #3 revokes all of this user's derived content sessions. */
export async function revokeAccessSession(
  db: D1Database,
  credentialId: string,
  epoch: number,
): Promise<void> {
  await atomicBatch(db, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [epoch]),
    assertExists(
      "SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id WHERE c.id=? AND c.kind='access' AND s.epoch=?",
      [credentialId, epoch],
    ),
    {
      sql: `UPDATE sessions SET revoked_at=COALESCE(revoked_at,strftime('%s','now')*1000)
        WHERE id=(SELECT session_id FROM credentials WHERE id=?)`,
      values: [credentialId],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,strftime('%s','now')*1000)
      WHERE user_id=(SELECT s.user_id FROM sessions s JOIN credentials c ON c.session_id=s.id WHERE c.id=?)`,
      values: [credentialId],
    },
  ]);
}
