import { scopes, type Principal } from "@ncf/shared";

import type { Env } from "../env.js";
import { bootstrapOwner } from "./bootstrap.js";
import { getOrCreateAccessSession } from "./sessions.js";
import { verifyAccessJwt } from "./accessJwt.js";

export interface AuthenticatedUser {
  principal: Extract<Principal, { kind: "user" }>;
  email: string;
  role: "member" | "app_admin";
}

const memberScopes = scopes.filter((scope) => !scope.startsWith("admin:"));

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${value}`;
}

function devEnabled(env: Env, request: Request): boolean {
  if (env.DEV_PRINCIPAL_EMAIL === undefined) {
    return false;
  }
  const url = new URL(request.url);
  if (
    url.pathname === "/s" ||
    url.pathname.startsWith("/s/") ||
    url.pathname.startsWith("/api/v1/public/")
  ) {
    return false;
  }
  const hostname = url.hostname;
  if (
    (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") ||
    (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1")
  ) {
    throw new Error("development_principal_forbidden");
  }
  return true;
}

async function ensureDevUser(env: Env): Promise<AuthenticatedUser> {
  const userId = env.DEV_PRINCIPAL_ID ?? "dev_user";
  const spaceId = env.DEV_SPACE_ID ?? "dev_space";
  const rootId = env.DEV_ROOT_NODE_ID ?? "dev_root";
  const sessionId = "dev_session";
  const email = env.DEV_PRINCIPAL_EMAIL;
  if (email === undefined) {
    throw new Error("development_principal_missing");
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO users(id,access_iss,access_sub,email,role,quota_bytes,used_bytes,physical_bytes,reserved_bytes,disabled_at,created_at) VALUES(?1,'dev://local',?1,?2,'app_admin',10737418240,0,0,0,NULL,?3)",
    ).bind(userId, email, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES(?1,?2,?3,1)",
    ).bind(spaceId, userId, rootId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES(?1,?2,?3,NULL,'','', 'root',NULL,1,NULL,?4,?4,NULL,NULL,NULL,0,NULL)",
    ).bind(rootId, spaceId, userId, now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES(?1,?2,'access',?3,?4,?5,NULL,?4) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=NULL,last_seen_at=excluded.last_seen_at",
    ).bind(sessionId, userId, `dev:${userId}`, now, now + 86_400_000),
  ]);
  return {
    email,
    role: "app_admin",
    principal: {
      kind: "user",
      principalId: userId,
      userId,
      sessionId,
      credentialId: `as:${sessionId}`,
      scopes: [...scopes],
    },
  };
}

async function resolveUser(
  env: Env,
  claims: Awaited<ReturnType<typeof verifyAccessJwt>>,
): Promise<AuthenticatedUser> {
  if (claims.subject === undefined || claims.email === undefined) {
    throw new Error("invalid_user_claims");
  }
  let user = await env.DB.prepare(
    "SELECT id,email,role FROM users WHERE access_iss=?1 AND access_sub=?2 AND disabled_at IS NULL",
  )
    .bind(claims.issuer, claims.subject)
    .first<{ id: string; email: string; role: "member" | "app_admin" }>();
  if (user === null) {
    const bootstrapState = await env.DB.prepare(
      "SELECT bootstrap_done_at value FROM control WHERE singleton=1",
    ).first<{ value: number | null }>();
    const allowed = env.OWNER_EMAILS.split(",").map((email) => email.trim().toLowerCase());
    if (bootstrapState?.value !== null || !allowed.includes(claims.email.toLowerCase())) {
      throw new Error("user_not_registered");
    }
    const userId = randomId("usr");
    await bootstrapOwner(env, {
      identity: { issuer: claims.issuer, subject: claims.subject, email: claims.email },
      allowedEmails: allowed,
      allowedIdentities: [],
      userId,
      spaceId: randomId("spc"),
      rootNodeId: randomId("nod"),
    });
    user = { id: userId, email: claims.email, role: "app_admin" };
  }
  const session = await getOrCreateAccessSession(env, user.id, {
    issuer: claims.issuer,
    subject: claims.subject,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
  return {
    email: user.email,
    role: user.role,
    principal: {
      kind: "user",
      principalId: user.id,
      userId: user.id,
      sessionId: session.id,
      credentialId: session.credentialId,
      scopes: user.role === "app_admin" ? [...scopes] : memberScopes,
    },
  };
}

export async function authenticateAccessUser(
  env: Env,
  request: Request,
): Promise<AuthenticatedUser> {
  if (devEnabled(env, request)) {
    return ensureDevUser(env);
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token.length === 0 || token.includes(",")) {
    throw new Error("access_token_required");
  }
  return resolveUser(env, await verifyAccessJwt(env, token, "user"));
}
