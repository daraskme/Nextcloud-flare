import {
  createAppPasswordBodySchema,
  type AppPasswordSummary,
  type CreatedAppPassword,
  type Scope,
} from "@ncf/shared";

import type { AuthenticatedUser } from "../auth/httpAuth.js";
import { randomToken } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { derivePbkdf2, toHex } from "./kdf.js";
import { getOwnedNode } from "./nodes.js";

const DEFAULT_SCOPES = ["node:read", "node:create", "node:write", "node:delete"] as const;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface AppPasswordRow {
  id: string;
  label: string;
  scopesJson: string;
  rootNodeId: string | null;
  expiresAt: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

function ulid(now = Date.now()): string {
  let time = BigInt(now);
  let prefix = "";
  for (let index = 0; index < 10; index += 1) {
    prefix = CROCKFORD.charAt(Number(time & 31n)) + prefix;
    time >>= 5n;
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let suffix = "";
  for (const value of random) suffix += CROCKFORD.charAt(value & 31);
  return `${prefix}${suffix}`;
}

function pepper(env: Env): string {
  if (env.APP_PASSWORD_PEPPER !== undefined && env.APP_PASSWORD_PEPPER.length >= 32) {
    return env.APP_PASSWORD_PEPPER;
  }
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") {
    return "local-only-app-password-pepper-not-for-production";
  }
  throw new Error("app_password_configuration_invalid");
}

export async function appPasswordDigest(
  env: Env,
  secret: string,
  salt: Uint8Array,
): Promise<string> {
  return toHex(await derivePbkdf2(`${secret}.${pepper(env)}`, salt));
}

function parseScopes(value: string): Scope[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("app_password_scopes_invalid");
  return parsed.map((scope) => {
    const result = createAppPasswordBodySchema.shape.scopes.unwrap().element.safeParse(scope);
    if (!result.success) throw new Error("app_password_scopes_invalid");
    return result.data;
  });
}

function summary(row: AppPasswordRow): AppPasswordSummary {
  return {
    id: row.id,
    label: row.label,
    scopes: parseScopes(row.scopesJson),
    rootNodeId: row.rootNodeId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

const selectAppPassword =
  "SELECT id,label,scopes_json scopesJson,root_node_id rootNodeId,expires_at expiresAt,created_at createdAt,last_used_at lastUsedAt,revoked_at revokedAt FROM app_passwords";

export async function listAppPasswords(env: Env, userId: string): Promise<AppPasswordSummary[]> {
  const rows = await env.DB.prepare(
    `${selectAppPassword} WHERE user_id=?1 ORDER BY created_at DESC,id DESC LIMIT 21`,
  )
    .bind(userId)
    .all<AppPasswordRow>();
  return rows.results.map(summary);
}

export async function createAppPassword(
  env: Env,
  user: AuthenticatedUser,
  input: unknown,
): Promise<CreatedAppPassword> {
  const parsed = createAppPasswordBodySchema.parse(input);
  const active = await env.DB.prepare(
    "SELECT COUNT(*) value FROM app_passwords WHERE user_id=?1 AND revoked_at IS NULL AND expires_at>(strftime('%s','now')*1000)",
  )
    .bind(user.principal.userId)
    .first<{ value: number }>();
  if ((active?.value ?? 0) >= 20) throw new Error("app_password_limit");
  if (parsed.rootNodeId !== undefined && parsed.rootNodeId !== null) {
    await getOwnedNode(env, user.principal.userId, parsed.rootNodeId);
  }
  const now = Date.now();
  const id = `ap_${ulid(now)}`;
  const sessionId = `aps_${ulid(now)}`;
  const secret = randomToken(32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await appPasswordDigest(env, secret, salt);
  const expiresAt = now + parsed.expiresInDays * 86_400_000;
  const scopes = parsed.scopes ?? [...DEFAULT_SCOPES];
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=?1 AND u.disabled_at IS NULL AND s.id=?2 AND s.kind='access' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000))",
    ).bind(user.principal.userId, user.principal.sessionId),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE (SELECT COUNT(*) FROM app_passwords WHERE user_id=?1 AND revoked_at IS NULL AND expires_at>(strftime('%s','now')*1000))>=20",
    ).bind(user.principal.userId),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES(?1,?2,'app_password',?3,?4,?5,NULL,?4)",
    ).bind(sessionId, user.principal.userId, `app-password:${id}`, now, expiresAt),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO app_passwords(id,user_id,session_id,secret_digest,kdf,kdf_params,kid,scopes_json,root_node_id,expires_at,revoked_at,created_at,label,last_used_at) VALUES(?1,?2,?3,?4,'PBKDF2-HMAC-SHA256',?5,'app-password-v1',?6,?7,?8,NULL,?9,?10,NULL)",
    ).bind(
      id,
      user.principal.userId,
      sessionId,
      digest,
      JSON.stringify({ iterations: 100_000, salt: Array.from(salt) }),
      JSON.stringify(scopes),
      parsed.rootNodeId ?? null,
      expiresAt,
      now,
      parsed.label,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  const row = await env.DB.prepare(`${selectAppPassword} WHERE id=?1`)
    .bind(id)
    .first<AppPasswordRow>();
  if (row === null) throw new Error("app_password_create_failed");
  return { ...summary(row), secret };
}

export async function revokeAppPassword(
  env: Env,
  user: AuthenticatedUser,
  credentialId: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE app_passwords SET revoked_at=?1 WHERE id=?2 AND user_id=?3 AND revoked_at IS NULL",
    ).bind(now, credentialId, user.principal.userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at=?1 WHERE id=(SELECT session_id FROM app_passwords WHERE id=?2 AND user_id=?3) AND kind='app_password' AND revoked_at IS NULL",
    ).bind(now, credentialId, user.principal.userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}
