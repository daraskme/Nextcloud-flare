import { scopeSchema, type Principal, type Scope } from "@ncf/shared";

import type { Env } from "../env.js";
import { appPasswordDigest } from "../services/appPasswords.js";

interface CredentialRow {
  id: string;
  userId: string;
  sessionId: string;
  secretDigest: string;
  kdf: string;
  kdfParams: string;
  kid: string;
  scopesJson: string;
  rootNodeId: string | null;
}

export interface AuthenticatedAppPassword {
  principal: Extract<Principal, { kind: "app_password" }>;
  sessionId: string;
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseBasic(request: Request): { id: string; secret: string } {
  if (new URL(request.url).protocol !== "https:") throw new Error("dav_https_required");
  if (request.headers.has("Origin")) throw new Error("dav_browser_forbidden");
  const authorization = request.headers.get("Authorization");
  if (authorization === null || authorization.includes(",")) {
    throw new Error("app_password_required");
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(authorization);
  if (match?.[1] === undefined) throw new Error("app_password_required");
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    if (bytes.byteLength > 512) throw new Error("app_password_required");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("app_password_required");
  }
  const separator = decoded.indexOf(":");
  const id = decoded.slice(0, separator);
  const secret = decoded.slice(separator + 1);
  if (!/^ap_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id) || separator < 1 || secret.length < 32) {
    throw new Error("app_password_required");
  }
  return { id, secret };
}

function parseRecord(row: CredentialRow): { scopes: Scope[]; salt: Uint8Array } {
  if (row.kdf !== "PBKDF2-HMAC-SHA256" || row.kid !== "app-password-v1") {
    throw new Error("app_password_invalid");
  }
  const params = JSON.parse(row.kdfParams) as { iterations?: unknown; salt?: unknown };
  if (
    params.iterations !== 100_000 ||
    !Array.isArray(params.salt) ||
    params.salt.length !== 16 ||
    !params.salt.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw new Error("app_password_invalid");
  }
  const parsedScopes: unknown = JSON.parse(row.scopesJson);
  if (!Array.isArray(parsedScopes)) throw new Error("app_password_invalid");
  const scopes = parsedScopes.map((scope) => scopeSchema.parse(scope));
  return { scopes, salt: Uint8Array.from(params.salt as number[]) };
}

export async function authenticateAppPassword(
  env: Env,
  request: Request,
): Promise<AuthenticatedAppPassword> {
  const basic = parseBasic(request);
  const row = await env.DB.prepare(
    "SELECT ap.id,ap.user_id userId,ap.session_id sessionId,ap.secret_digest secretDigest,ap.kdf,ap.kdf_params kdfParams,ap.kid,ap.scopes_json scopesJson,ap.root_node_id rootNodeId FROM app_passwords ap JOIN sessions s ON s.id=ap.session_id AND s.user_id=ap.user_id JOIN users u ON u.id=ap.user_id WHERE ap.id=?1 AND ap.revoked_at IS NULL AND ap.expires_at>(strftime('%s','now')*1000) AND s.kind='app_password' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL",
  )
    .bind(basic.id)
    .first<CredentialRow>();
  if (row === null) {
    await appPasswordDigest(env, basic.secret, new Uint8Array(16));
    throw new Error("app_password_required");
  }
  const record = parseRecord(row);
  const digest = await appPasswordDigest(env, basic.secret, record.salt);
  if (!equalHex(digest, row.secretDigest)) throw new Error("app_password_required");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE app_passwords SET last_used_at=?1 WHERE id=?2 AND revoked_at IS NULL AND expires_at>?1",
    ).bind(now, row.id),
    env.DB.prepare(
      "UPDATE sessions SET last_seen_at=?1 WHERE id=?2 AND revoked_at IS NULL AND expires_at>?1",
    ).bind(now, row.sessionId),
  ]);
  return {
    sessionId: row.sessionId,
    principal: {
      kind: "app_password",
      principalId: row.userId,
      userId: row.userId,
      credentialId: row.id,
      appPasswordId: row.id,
      rootNodeId: row.rootNodeId,
      scopes: record.scopes,
    },
  };
}
