import { assertExists, primary, type SqlStatement } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "../services/accountMutation";

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
  env: AccountMutationEnv,
  claims: AccessClaims,
  epoch: number,
): Promise<AccessSession> {
  const db = env.DB;
  const fingerprint = await accessFingerprint(claims);
  const readCurrent = () =>
    primary(db)
      .prepare(
        LIVE_ACCESS.replace("c.id=?1", "s.fingerprint=?1") +
          " AND ctl.maintenance=0 AND u.access_iss=?3 AND u.access_sub=?4 AND s.issued_at=?5 AND s.expires_at=?6",
      )
      .bind(fingerprint, epoch, claims.iss, claims.sub, claims.iat * 1000, claims.exp * 1000)
      .first<AccessSession>();
  // Existing JWTs are read-only. Tombstones and missing credentials are never repaired by login.
  if (
    await primary(db)
      .prepare("SELECT 1 FROM sessions WHERE fingerprint=?")
      .bind(fingerprint)
      .first()
  ) {
    const session = await readCurrent();
    if (!session) throw new Error("credential_inactive");
    return session;
  }
  const userId = await primary(db)
    .prepare(
      "SELECT u.id FROM users u JOIN control c ON c.singleton=1 WHERE u.access_iss=? AND u.access_sub=? AND u.disabled_at IS NULL AND c.epoch=? AND c.maintenance=0 AND ?>strftime('%s','now')*1000",
    )
    .bind(claims.iss, claims.sub, epoch, claims.exp * 1000)
    .first<string>("id");
  if (!userId) throw new Error("credential_inactive");
  const admission = await acquireAccountMutation(env, userId, epoch, "session.register");
  const id = crypto.randomUUID();
  await commitAccountMutation(db, admission, userId, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [epoch]),
    assertExists(
      "SELECT 1 FROM users WHERE access_iss=? AND access_sub=? AND id=? AND disabled_at IS NULL",
      [claims.iss, claims.sub, userId],
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
      AND s.epoch=? AND s.issued_at=? AND s.expires_at=? AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000)
      AND u.access_iss=? AND u.access_sub=? AND u.disabled_at IS NULL`,
      [fingerprint, epoch, claims.iat * 1000, claims.exp * 1000, claims.iss, claims.sub],
    ),
    {
      sql: "INSERT INTO credentials(id,kind,session_id) SELECT 'as:'||id,'access',id FROM sessions WHERE fingerprint=? AND id=? ON CONFLICT(id) DO NOTHING",
      values: [fingerprint, id],
    },
    assertExists(
      "SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id WHERE s.fingerprint=? AND c.kind='access'",
      [fingerprint],
    ),
  ]);
  const session = await readCurrent();
  if (!session) throw new Error("credential_inactive");
  return session;
}

/** Repeated logout is idempotent. R6 #3 revokes all of this user's derived content sessions. */
export async function revokeAccessSession(
  env: AccountMutationEnv,
  credentialId: string,
  epoch: number,
): Promise<void> {
  const db = env.DB;
  const userId = await primary(db)
    .prepare(
      "SELECT s.user_id FROM credentials c JOIN sessions s ON s.id=c.session_id JOIN control ctl ON ctl.singleton=1 WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.epoch=? AND ctl.epoch=? AND ctl.maintenance=0",
    )
    .bind(credentialId, epoch, epoch)
    .first<string>("user_id");
  if (!userId) throw new Error("credential_inactive");
  const admission = await acquireAccountMutation(env, userId, epoch, "session.revoke");
  await commitAccountMutation(
    db,
    admission,
    userId,
    [
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        epoch,
      ]),
      assertExists(
        "SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.epoch=? AND s.user_id=?",
        [credentialId, epoch, userId],
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
    ],
    { allowDisabled: true },
  );
}
