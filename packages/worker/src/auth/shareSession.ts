import { base64url } from "jose";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
} from "../services/accountMutation";
import type { Principal } from "./authorize";
import { KdfUnavailableError } from "./kdf";
import {
  hashSharePassword,
  type SharePasswordPepperRing,
  type SharePasswordRecord,
  verifySharePassword,
} from "./sharePassword";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SESSION_TTL_MS = 7 * 86_400_000;
const ACTIVE_SESSION_LIMIT = 64;
const SOURCE_SESSION_LIMIT = 8;

interface LiveShareRow {
  id: string;
  ownerId: string;
  rootNodeId: string;
  kind: "link" | "upload_only";
  version: number;
  expiresAt: number | null;
  passwordDigest: string | null;
  salt: string | null;
  kdf: string | null;
  kdfParams: string | null;
  kid: string | null;
}

export class SharePasswordRequiredError extends Error {
  constructor() {
    super("share_password_required");
  }
}

export interface ShareUnlockOptions {
  readonly password?: string;
  readonly passwordRing?: SharePasswordPepperRing;
  readonly signal?: AbortSignal;
  readonly admitPasswordAttempt?: () => Promise<void>;
  readonly sourceDigest: string;
  readonly existingCookieSecret?: string;
}

export interface ShareSession {
  readonly id: string;
  readonly credentialId: string;
  readonly shareId: string;
  readonly shareVersion: number;
  readonly ownerId: string;
  readonly rootNodeId: string;
  readonly spaceId: string;
  readonly kind: "link" | "upload_only";
  readonly epoch: number;
  readonly expiresAt: number;
  readonly shareExpiresAt: number | null;
  readonly createdAt: number;
}

function secretBytes(secret: string): Uint8Array {
  if (!SECRET.test(secret)) throw new Error("share_unauthorized");
  const bytes = base64url.decode(secret);
  if (bytes.length !== 32 || base64url.encode(bytes) !== secret)
    throw new Error("share_unauthorized");
  return bytes;
}

export async function shareSecretDigest(secret: string): Promise<string> {
  return base64url.encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes(secret))),
  );
}

function cookieName(shareId: string): string {
  if (!ID.test(shareId)) throw new Error("share_unauthorized");
  return `__Host-ncf_share_${shareId.slice(0, 24)}`;
}

function cookieValue(request: Request, shareId: string): string {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 8192) throw new Error("share_unauthorized");
  const name = cookieName(shareId);
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) throw new Error("share_unauthorized");
  secretBytes(values[0] ?? "");
  return values[0] ?? "";
}

export function shareCookie(
  shareId: string,
  secret: string,
  expiresAt: number,
  now = Date.now(),
): string {
  secretBytes(secret);
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${cookieName(shareId)}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearShareCookie(shareId: string): string {
  return `${cookieName(shareId)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function existingShareCookie(request: Request, shareId: string): string | undefined {
  try {
    return cookieValue(request, shareId);
  } catch {
    return undefined;
  }
}

export class ShareSessionSourceLimitError extends Error {
  constructor() {
    super("share_session_source_limit");
  }
}

const LIVE_SHARE = `WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
  SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,0,'/'||n.id||'/'
    FROM shares sh JOIN nodes n ON n.id=sh.root_node_id WHERE sh.id=?1
  UNION ALL
  SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.path||n.id||'/'
    FROM nodes n JOIN a ON n.id=a.parent_id
    WHERE a.depth<64 AND n.space_id=a.space_id AND n.owner_id=a.owner_id
      AND instr(a.path,'/'||n.id||'/')=0
) SELECT sh.id,sh.owner_id AS ownerId,sh.root_node_id AS rootNodeId,
  sh.kind,sh.version,sh.expires_at AS expiresAt,sh.password_digest AS passwordDigest,
  sh.salt,sh.kdf,sh.kdf_params AS kdfParams,sh.kid
  FROM shares sh JOIN users owner ON owner.id=sh.owner_id
  JOIN control ctl ON ctl.singleton=1
  WHERE sh.id=?1 AND sh.kind IN ('link','upload_only') AND sh.secret_digest=?2
    AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
    AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
    AND ctl.epoch=?3 AND ctl.maintenance=0
    AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id
      AND action=CASE sh.kind WHEN 'link' THEN 'read' ELSE 'upload' END)
    AND (sh.kind<>'upload_only' OR EXISTS(
      SELECT 1 FROM nodes root WHERE root.id=sh.root_node_id AND root.kind IN ('root','folder')))
    AND EXISTS(SELECT COUNT(*) FROM a HAVING COUNT(*) BETWEEN 1 AND 65
      AND MIN(deleted_at IS NULL)=1
      AND MIN(space_id=(SELECT space_id FROM a WHERE id=sh.root_node_id))=1
      AND MIN(owner_id=sh.owner_id)=1
      AND SUM(kind='root' AND parent_id IS NULL)=1)`;

export async function unlockShare(
  env: Env,
  shareId: string,
  secret: string,
  epoch: number,
  options: ShareUnlockOptions,
): Promise<{ session: ShareSession; cookieSecret: string }> {
  if (!ID.test(shareId) || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("share_unauthorized");
  if (!SECRET.test(options.sourceDigest)) throw new Error("share_unauthorized");
  const digest = await shareSecretDigest(secret);
  const share = await primary(env.DB)
    .prepare(LIVE_SHARE)
    .bind(shareId, digest, epoch)
    .first<LiveShareRow>();
  if (!share) throw new Error("share_unauthorized");
  let passwordAssertion;
  const passwordMutations: SqlStatement[] = [];
  if (share.passwordDigest === null) {
    passwordAssertion = assertExists(
      "SELECT 1 FROM shares WHERE id=? AND password_digest IS NULL",
      [share.id],
    );
  } else {
    if (
      share.salt === null ||
      share.kdf !== "PBKDF2-SHA256" ||
      share.kdfParams === null ||
      share.kid === null
    )
      throw new Error("share_unauthorized");
    if (options.password === undefined) throw new SharePasswordRequiredError();
    if (!options.passwordRing) throw new KdfUnavailableError();
    await options.admitPasswordAttempt?.();
    const record: SharePasswordRecord = {
      passwordDigest: share.passwordDigest,
      salt: share.salt,
      kdf: share.kdf,
      kdfParams: share.kdfParams,
      kid: share.kid,
    };
    if (
      !(await verifySharePassword(options.password, record, options.passwordRing, options.signal))
    )
      throw new SharePasswordRequiredError();
    passwordAssertion = assertExists(
      `SELECT 1 FROM shares
        WHERE id=? AND password_digest=? AND salt=? AND kdf=? AND kdf_params=? AND kid=?`,
      [share.id, record.passwordDigest, record.salt, record.kdf, record.kdfParams, record.kid],
    );
    if (record.kid !== options.passwordRing.activeKid) {
      const replacement = await hashSharePassword(
        options.password,
        options.passwordRing,
        options.signal,
      );
      passwordMutations.push({
        sql: `UPDATE shares SET password_digest=?,salt=?,kdf=?,kdf_params=?,kid=?
          WHERE id=? AND password_digest=? AND salt=? AND kdf=? AND kdf_params=? AND kid=?`,
        values: [
          replacement.passwordDigest,
          replacement.salt,
          replacement.kdf,
          replacement.kdfParams,
          replacement.kid,
          share.id,
          record.passwordDigest,
          record.salt,
          record.kdf,
          record.kdfParams,
          record.kid,
        ],
      });
    }
  }
  if (options.existingCookieSecret) {
    const existing = await readShareSession(env.DB, share.id, options.existingCookieSecret, epoch);
    if (existing && existing.shareVersion === share.version) {
      if (passwordMutations.length > 0) {
        const admission = await acquireAccountMutation(env, share.ownerId, epoch, "share.unlock");
        await commitAccountMutation(env.DB, admission, share.ownerId, [
          assertExists(LIVE_SHARE, [share.id, digest, epoch]),
          passwordAssertion,
          assertExists(
            `SELECT 1 FROM share_sessions WHERE id=? AND share_id=? AND share_version=?
              AND epoch=? AND revoked_at IS NULL AND expires_at>strftime('%s','now')*1000`,
            [existing.id, share.id, share.version, epoch],
          ),
          ...passwordMutations,
        ]);
      }
      return { session: existing, cookieSecret: options.existingCookieSecret };
    }
  }
  const sourceActive = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM share_sessions
      WHERE share_id=? AND share_version=? AND epoch=? AND source_digest=?
        AND revoked_at IS NULL AND expires_at>strftime('%s','now')*1000`)
    .bind(share.id, share.version, epoch, options.sourceDigest)
    .first<number>("count");
  if (sourceActive === null || sourceActive >= SOURCE_SESSION_LIMIT)
    throw new ShareSessionSourceLimitError();
  const active = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM share_sessions
      WHERE share_id=? AND share_version=? AND epoch=? AND revoked_at IS NULL
        AND expires_at>strftime('%s','now')*1000`)
    .bind(share.id, share.version, epoch)
    .first<number>("count");
  if (active === null || active >= ACTIVE_SESSION_LIMIT) throw new MutationUnavailableError();
  const now = Date.now();
  const expiresAt = Math.min(share.expiresAt ?? now + SESSION_TTL_MS, now + SESSION_TTL_MS);
  if (expiresAt <= now) throw new Error("share_unauthorized");
  const sessionId = crypto.randomUUID();
  const credentialId = `ss:${sessionId}`;
  const cookieSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cookieDigest = await shareSecretDigest(cookieSecret);
  const admission = await acquireAccountMutation(env, share.ownerId, epoch, "share.unlock");
  await commitAccountMutation(env.DB, admission, share.ownerId, [
    assertExists(LIVE_SHARE, [share.id, digest, epoch]),
    assertExists("SELECT 1 FROM shares WHERE id=? AND version=?", [share.id, share.version]),
    passwordAssertion,
    ...passwordMutations,
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM share_sessions
        WHERE share_id=? AND share_version=? AND epoch=? AND revoked_at IS NULL
          AND expires_at>strftime('%s','now')*1000)<?`,
      [share.id, share.version, epoch, ACTIVE_SESSION_LIMIT],
    ),
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM share_sessions
        WHERE share_id=? AND share_version=? AND epoch=? AND source_digest=?
          AND revoked_at IS NULL AND expires_at>strftime('%s','now')*1000)<?`,
      [share.id, share.version, epoch, options.sourceDigest, SOURCE_SESSION_LIMIT],
    ),
    {
      sql: `INSERT INTO share_sessions(
        id,share_id,share_version,secret_digest,epoch,issued_at,expires_at,source_digest
      ) VALUES(?,?,?,?,?,?,?,?)`,
      values: [
        sessionId,
        share.id,
        share.version,
        cookieDigest,
        epoch,
        now,
        expiresAt,
        options.sourceDigest,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [credentialId, sessionId],
    },
  ]);
  const session = await readShareSession(env.DB, shareId, cookieSecret, epoch);
  if (!session) throw new Error("share_commit_unknown");
  return { session, cookieSecret };
}

export async function readShareSession(
  db: D1Database,
  shareId: string,
  secret: string,
  epoch: number,
): Promise<ShareSession | null> {
  if (!ID.test(shareId) || !Number.isSafeInteger(epoch) || epoch < 1) return null;
  let digest: string;
  try {
    digest = await shareSecretDigest(secret);
  } catch {
    return null;
  }
  return primary(db)
    .prepare(`SELECT ss.id,c.id AS credentialId,sh.id AS shareId,
      sh.version AS shareVersion,sh.owner_id AS ownerId,sh.root_node_id AS rootNodeId,
      root.space_id AS spaceId,sh.kind,ss.epoch,ss.expires_at AS expiresAt,sh.expires_at AS shareExpiresAt,
      sh.created_at AS createdAt
      FROM share_sessions ss JOIN credentials c ON c.share_session_id=ss.id AND c.kind='share'
      JOIN shares sh ON sh.id=ss.share_id JOIN users owner ON owner.id=sh.owner_id
      JOIN nodes root ON root.id=sh.root_node_id AND root.owner_id=sh.owner_id
      JOIN control ctl ON ctl.singleton=1
      WHERE sh.id=? AND ss.secret_digest=? AND ss.share_version=sh.version
        AND sh.kind IN ('link','upload_only') AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
        AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
        AND ss.revoked_at IS NULL AND ss.expires_at>strftime('%s','now')*1000
        AND ss.epoch=? AND ctl.epoch=ss.epoch AND ctl.maintenance=0
        AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id
          AND action=CASE sh.kind WHEN 'link' THEN 'read' ELSE 'upload' END)
        AND (sh.kind<>'upload_only' OR EXISTS(
          SELECT 1 FROM nodes root WHERE root.id=sh.root_node_id AND root.kind IN ('root','folder')) )`)
    .bind(shareId, digest, epoch)
    .first<ShareSession>();
}

export async function authenticateShareSession(
  db: D1Database,
  request: Request,
  shareId: string,
  epoch: number,
): Promise<ShareSession> {
  const session = await readShareSession(db, shareId, cookieValue(request, shareId), epoch);
  if (!session) throw new Error("share_unauthorized");
  return Object.freeze(session);
}

export function sharePrincipal(session: ShareSession): Principal {
  return {
    kind: "link_share",
    share_id: session.shareId,
    share_version: session.shareVersion,
    credential_id: session.credentialId,
    epoch: session.epoch,
  };
}

export async function revokeShareSession(env: Env, session: ShareSession): Promise<void> {
  const admission = await acquireAccountMutation(
    env,
    session.ownerId,
    session.epoch,
    "share.logout",
  );
  const clock = "strftime('%s','now')*1000";
  await commitAccountMutation(env.DB, admission, session.ownerId, [
    assertExists(
      `SELECT 1 FROM share_sessions ss JOIN shares sh ON sh.id=ss.share_id
        JOIN control ctl ON ctl.singleton=1
        WHERE ss.id=? AND sh.id=? AND sh.owner_id=? AND ss.epoch=? AND ctl.epoch=?`,
      [session.id, session.shareId, session.ownerId, session.epoch, session.epoch],
    ),
    {
      sql: `UPDATE share_sessions SET revoked_at=COALESCE(revoked_at,${clock}) WHERE id=?`,
      values: [session.id],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE issued_by_credential_id=?`,
      values: [session.credentialId],
    },
    {
      sql: "UPDATE budgets SET state='revoked' WHERE unlock_session_id=? AND state='active'",
      values: [session.id],
    },
  ]);
  await atomicBatch(env.DB, [
    assertExists("SELECT 1 FROM share_sessions WHERE id=? AND revoked_at IS NOT NULL", [
      session.id,
    ]),
  ]);
}
