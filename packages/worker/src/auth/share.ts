import type { Principal } from "@ncf/shared";

import type { Env } from "../env.js";
import { issueCsrfToken, verifyCsrfToken } from "./csrf.js";
import {
  capability,
  loadPublicShare,
  shareTreeBytes,
  type ShareCapability,
  verifySharePassword,
} from "../services/shares.js";
import { randomToken, sha256 } from "./tokens.js";

const SHARE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthenticatedShare {
  principal: Extract<Principal, { kind: "share" }>;
  sessionId: string;
  share: ShareCapability;
  budgetId: string;
  budgetMaxBytes: number;
}

function cookieName(shareId: string): string {
  return `__Host-ncf_share_${shareId}`;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  return matches[0]?.slice(name.length + 1) ?? null;
}

function scopesForShare(share: ShareCapability): Extract<Principal, { kind: "share" }>["scopes"] {
  const scopes: Extract<Principal, { kind: "share" }>["scopes"] = [];
  if (share.actions.includes("read")) scopes.push("node:read");
  if (share.actions.includes("upload")) scopes.push("upload:create", "upload:write");
  return scopes;
}

export async function unlockShare(
  env: Env,
  request: Request,
  shareId: string,
  secret: string,
  password?: string,
  now = Date.now(),
): Promise<{ authentication: AuthenticatedShare; cookie: string }> {
  const limiter = (env as unknown as { EDGE_LIMITER?: RateLimit }).EDGE_LIMITER;
  if (limiter !== undefined) {
    const rate = await limiter.limit({
      key: `share-unlock:${shareId}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    });
    if (!rate.success) throw new Error("share_unlock_rate_limited");
  }
  const row = await loadPublicShare(env, shareId, now);
  if (
    (await sha256(secret)) !== row.linkSecretDigest ||
    !(await verifySharePassword(row, password))
  ) {
    throw new Error("share_unlock_failed");
  }
  const share = capability(row);
  const totalBytes = await shareTreeBytes(env, share);
  if (totalBytes > Math.floor(Number.MAX_SAFE_INTEGER / 3))
    throw new Error("share_budget_exceeded");
  const sessionId = `ss_${randomToken(18)}`;
  const opaque = randomToken(32);
  const fingerprint = await sha256(`${sessionId}.${opaque}`);
  const budgetId = `s:${share.id}:c:${sessionId}`;
  const budgetMaxBytes = totalBytes * 3;
  const expiresAt = Math.min(
    now + SHARE_SESSION_TTL_MS,
    share.expiresAt ?? Number.MAX_SAFE_INTEGER,
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares s JOIN users u ON u.id=s.owner_id WHERE s.id=?1 AND s.version=?2 AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?3) AND u.disabled_at IS NULL)",
    ).bind(share.id, share.version, now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES(?1,?2,'share',?3,?4,?5,NULL,?4)",
    ).bind(sessionId, share.ownerId, fingerprint, now, expiresAt),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO share_sessions(id,share_id,share_version,fingerprint,issued_at,expires_at,revoked_at,budget_id,budget_max_bytes) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,?8)",
    ).bind(
      sessionId,
      share.id,
      share.version,
      fingerprint,
      now,
      expiresAt,
      budgetId,
      budgetMaxBytes,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return {
    authentication: {
      sessionId,
      share,
      budgetId,
      budgetMaxBytes,
      principal: {
        kind: "share",
        principalId: share.id,
        credentialId: `ss:${sessionId}`,
        scopes: scopesForShare(share),
        shareId: share.id,
        shareVersion: share.version,
        rootNodeId: share.rootNodeId,
      },
    },
    cookie: `${cookieName(share.id)}=${sessionId}.${opaque}; Path=/; Max-Age=${Math.floor((expiresAt - now) / 1000)}; Secure; HttpOnly; SameSite=Lax`,
  };
}

export async function authenticateShare(
  env: Env,
  request: Request,
  shareId: string,
  now = Date.now(),
): Promise<AuthenticatedShare> {
  const value = cookieValue(request, cookieName(shareId));
  if (value === null || value.length > 512) throw new Error("share_session_required");
  const separator = value.indexOf(".");
  if (separator < 1) throw new Error("share_session_required");
  const sessionId = value.slice(0, separator);
  const fingerprint = await sha256(value);
  const session = await env.DB.prepare(
    "SELECT ss.share_version shareVersion,ss.budget_id budgetId,ss.budget_max_bytes budgetMaxBytes FROM share_sessions ss JOIN sessions se ON se.id=ss.id JOIN shares s ON s.id=ss.share_id JOIN users u ON u.id=s.owner_id WHERE ss.id=?1 AND ss.share_id=?2 AND ss.fingerprint=?3 AND ss.revoked_at IS NULL AND ss.expires_at>?4 AND se.kind='share' AND se.fingerprint=?3 AND se.revoked_at IS NULL AND se.expires_at>?4 AND s.version=ss.share_version AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?4) AND u.disabled_at IS NULL",
  )
    .bind(sessionId, shareId, fingerprint, now)
    .first<{ shareVersion: number; budgetId: string | null; budgetMaxBytes: number | null }>();
  if (session?.budgetId == null || session.budgetMaxBytes === null) {
    throw new Error("share_session_required");
  }
  const share = capability(await loadPublicShare(env, shareId, now));
  if (share.version !== session.shareVersion) throw new Error("share_session_required");
  return {
    sessionId,
    share,
    budgetId: session.budgetId,
    budgetMaxBytes: session.budgetMaxBytes,
    principal: {
      kind: "share",
      principalId: share.id,
      credentialId: `ss:${sessionId}`,
      scopes: scopesForShare(share),
      shareId: share.id,
      shareVersion: share.version,
      rootNodeId: share.rootNodeId,
    },
  };
}

function csrfSecret(env: Env): string {
  const secret = env.CSRF_KEY ?? env.DEV_CSRF_KEY;
  if (
    secret === undefined ||
    secret.length < 16 ||
    (env.CSRF_KEY === undefined && env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test")
  ) {
    throw new Error("csrf_configuration_invalid");
  }
  return secret;
}

export async function issueShareCsrf(env: Env, sessionId: string): Promise<string> {
  return issueCsrfToken(csrfSecret(env), sessionId);
}

export async function verifyShareCsrf(
  env: Env,
  request: Request,
  shareId: string,
): Promise<boolean> {
  const authentication = await authenticateShare(env, request, shareId);
  const token = request.headers.get("X-CSRF-Token");
  return token !== null && verifyCsrfToken(csrfSecret(env), token, authentication.sessionId);
}

export async function logoutShare(
  env: Env,
  request: Request,
  shareId: string,
  now = Date.now(),
): Promise<string> {
  const authentication = await authenticateShare(env, request, shareId, now);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE share_sessions SET revoked_at=?1 WHERE id=?2 AND share_id=?3 AND revoked_at IS NULL",
    ).bind(now, authentication.sessionId, shareId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND kind='share' AND revoked_at IS NULL",
    ).bind(now, authentication.sessionId),
    env.DB.prepare(
      "UPDATE content_sessions SET revoked_at=?1 WHERE issued_by_credential_id=?2 AND revoked_at IS NULL",
    ).bind(now, authentication.sessionId),
  ]);
  return `${cookieName(shareId)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
