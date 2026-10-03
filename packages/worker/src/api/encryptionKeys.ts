import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import {
  type AccessSession,
  assertLiveAccessCredential,
  readAccessSession,
} from "../auth/sessions";
import { assertExists, assertOneChange, primary } from "../db/primary";
import type { Env } from "../env";
import {
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
} from "../services/accountMutation";

const ROOT = "/api/v1/encryption";
const ACCOUNT = /^\/api\/v1\/encryption\/keys\/([A-Za-z0-9_-]{1,128})$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const encoder = new TextEncoder();

export function encryptionKeyRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "POST" &&
      [ROOT + "/keys/challenge", ROOT + "/keys/register"].includes(path)) ||
    (request.method === "GET" && (path === ROOT + "/admin-keys" || ACCOUNT.test(path)))
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((max * 4) / 3) + 3
  )
    throw new Error("invalid_encryption_key");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error("invalid_encryption_key");
  }
  if (bytes.length < min || bytes.length > max || base64url(bytes) !== value)
    throw new Error("invalid_encryption_key");
  return bytes;
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== keys.sort().join("\0")
  )
    throw new Error("invalid_encryption_key");
  return value as Record<string, unknown>;
}

async function key(value: unknown, kind: "rsa" | "signing") {
  const input = exact(value, ["fingerprint", "spki"]);
  const bytes = decode(input.spki, kind === "rsa" ? 300 : 40, kind === "rsa" ? 800 : 100);
  const fingerprint = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (fingerprint !== input.fingerprint) throw new Error("invalid_encryption_key");
  let imported: CryptoKey;
  try {
    imported = await crypto.subtle.importKey(
      "spki",
      bytes,
      kind === "rsa" ? { name: "RSA-OAEP", hash: "SHA-256" } : { name: "Ed25519" },
      false,
      kind === "rsa" ? ["encrypt"] : ["verify"],
    );
  } catch {
    throw new Error("invalid_encryption_key");
  }
  if (kind === "rsa" && (imported.algorithm as { modulusLength: number }).modulusLength !== 3072)
    throw new Error("invalid_encryption_key");
  return { encoded: input.spki as string, fingerprint, imported };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_encryption_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("invalid_encryption_body");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return exact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)),
      new URL(request.url).pathname.endsWith("/challenge")
        ? ["recipient", "signer"]
        : ["challengeId", "secret", "signature"],
    );
  } catch {
    throw new Error("invalid_encryption_body");
  }
}

interface ChallengeRow {
  id: string;
  accountId: string;
  credentialId: string;
  epoch: number;
  rsaFingerprint: string;
  rsaSpki: string;
  signingFingerprint: string;
  signingSpki: string;
  secretSha256: string;
  expiresAt: number;
  consumedAt: number | null;
}

async function live(env: Env, session: AccessSession) {
  const current = await readAccessSession(env.DB, session.credential_id, session.epoch);
  return current?.user_id === session.user_id ? current : null;
}

async function challenge(env: Env, session: AccessSession, body: Record<string, unknown>) {
  const recipient = await key(body.recipient, "rsa");
  const signer = await key(body.signer, "signing");
  const exists = await primary(env.DB)
    .prepare("SELECT 1 FROM encryption_keys WHERE account_id=?")
    .bind(session.user_id)
    .first();
  if (exists) throw new Error("encryption_key_exists");
  const id = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const secretSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", secret)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const expiresAt = Date.now() + 300000;
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
        label: encoder.encode(`ncf-key-registration-v1\0${id}\0${session.user_id}`),
      },
      recipient.imported,
      secret,
    );
  } finally {
    secret.fill(0);
  }
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "encryption.key.challenge",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists("SELECT 1 FROM sessions WHERE id=? AND user_id=?", [
      session.session_id,
      session.user_id,
    ]),
    assertExists("SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM encryption_keys WHERE account_id=?)", [
      session.user_id,
    ]),
    assertExists(
      "SELECT 1 WHERE (SELECT COUNT(*) FROM encryption_key_challenges WHERE account_id=? AND consumed_at IS NULL AND expires_at>strftime('%s','now')*1000)<3",
      [session.user_id],
    ),
    {
      sql: `INSERT INTO encryption_key_challenges(id,account_id,credential_id,epoch,rsa_fingerprint,rsa_spki,signing_fingerprint,signing_spki,secret_sha256,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,strftime('%s','now')*1000,?)`,
      values: [
        id,
        session.user_id,
        session.credential_id,
        session.epoch,
        recipient.fingerprint,
        recipient.encoded,
        signer.fingerprint,
        signer.encoded,
        secretSha256,
        expiresAt,
      ],
    },
  ]);
  return { id, ciphertext: base64url(new Uint8Array(ciphertext)), expiresAt };
}

async function register(env: Env, session: AccessSession, body: Record<string, unknown>) {
  const id = body.challengeId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
    throw new Error("invalid_encryption_key");
  const secret = decode(body.secret, 32, 32);
  const signature = decode(body.signature, 64, 64);
  const row = await primary(env.DB)
    .prepare(`SELECT id,account_id AS accountId,credential_id AS credentialId,epoch,
    rsa_fingerprint AS rsaFingerprint,rsa_spki AS rsaSpki,signing_fingerprint AS signingFingerprint,
    signing_spki AS signingSpki,secret_sha256 AS secretSha256,expires_at AS expiresAt,
    consumed_at AS consumedAt FROM encryption_key_challenges WHERE id=?`)
    .bind(id)
    .first<ChallengeRow>();
  if (
    !row ||
    row.accountId !== session.user_id ||
    row.credentialId !== session.credential_id ||
    row.epoch !== session.epoch ||
    row.expiresAt <= Date.now()
  )
    throw new Error("encryption_challenge_expired");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", secret)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== row.secretSha256) throw new Error("encryption_challenge_invalid");
  const signing = await key(
    { fingerprint: row.signingFingerprint, spki: row.signingSpki },
    "signing",
  );
  const statement = encoder.encode(
    `ncf-encryption-key-register-v1\0${id}\0${session.user_id}\0${body.secret}\0${row.rsaFingerprint}\0${row.signingFingerprint}`,
  );
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, signing.imported, signature, statement)))
    throw new Error("encryption_challenge_invalid");
  const current = await primary(env.DB)
    .prepare(
      `SELECT rsa_fingerprint AS rsaFingerprint,signing_fingerprint AS signingFingerprint,revoked_at AS revokedAt FROM encryption_keys WHERE account_id=?`,
    )
    .bind(session.user_id)
    .first<{ rsaFingerprint: string; signingFingerprint: string; revokedAt: number | null }>();
  if (row.consumedAt !== null) {
    if (
      current?.revokedAt === null &&
      current.rsaFingerprint === row.rsaFingerprint &&
      current.signingFingerprint === row.signingFingerprint
    )
      return {
        accountId: session.user_id,
        recipient: { fingerprint: row.rsaFingerprint, spki: row.rsaSpki },
        signer: { fingerprint: row.signingFingerprint, spki: row.signingSpki },
      };
    throw new Error("encryption_key_exists");
  }
  if (current) throw new Error("encryption_key_exists");
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "encryption.key.register",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      "SELECT 1 FROM encryption_key_challenges WHERE id=? AND account_id=? AND credential_id=? AND epoch=? AND consumed_at IS NULL AND expires_at>strftime('%s','now')*1000",
      [id, session.user_id, session.credential_id, session.epoch],
    ),
    assertExists("SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM encryption_keys WHERE account_id=?)", [
      session.user_id,
    ]),
    {
      sql: `INSERT INTO encryption_keys(account_id,rsa_fingerprint,rsa_spki,signing_fingerprint,signing_spki,registered_at)
      VALUES(?,?,?,?,?,strftime('%s','now')*1000)`,
      values: [
        session.user_id,
        row.rsaFingerprint,
        row.rsaSpki,
        row.signingFingerprint,
        row.signingSpki,
      ],
    },
    assertOneChange,
    {
      sql: "UPDATE encryption_key_challenges SET consumed_at=strftime('%s','now')*1000 WHERE id=? AND consumed_at IS NULL",
      values: [id],
    },
    assertOneChange,
  ]);
  return {
    accountId: session.user_id,
    recipient: { fingerprint: row.rsaFingerprint, spki: row.rsaSpki },
    signer: { fingerprint: row.signingFingerprint, spki: row.signingSpki },
  };
}

export async function handleEncryptionKeyHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash || !encryptionKeyRoute(request))
    return problem(404, "not_found");
  const currentSession = await live(env, session);
  if (!currentSession) return problem(403, "forbidden");
  if (request.method === "GET") {
    if (request.body) return problem(400, "bad_request");
    const target = ACCOUNT.exec(url.pathname)?.[1];
    if (target && target !== session.user_id && currentSession.role !== "app_admin")
      return problem(403, "forbidden");
    const rows = await primary(env.DB)
      .prepare(`SELECT k.account_id AS accountId,k.rsa_fingerprint AS rsaFingerprint,k.rsa_spki AS rsaSpki,
      k.signing_fingerprint AS signingFingerprint,k.signing_spki AS signingSpki,k.registered_at AS registeredAt
      FROM encryption_keys k JOIN users u ON u.id=k.account_id AND u.disabled_at IS NULL
      WHERE k.revoked_at IS NULL AND ${target ? "k.account_id=?" : "u.role='app_admin'"}
      ORDER BY k.account_id LIMIT 16`)
      .bind(...(target ? [target] : []))
      .all();
    if (!(await live(env, session))) return problem(403, "forbidden");
    return Response.json(
      {
        keys: (rows.results ?? []).map((row: Record<string, unknown>) => ({
          accountId: row.accountId,
          recipient: { fingerprint: row.rsaFingerprint, spki: row.rsaSpki },
          signer: { fingerprint: row.signingFingerprint, spki: row.signingSpki },
          registeredAt: row.registeredAt,
        })),
      },
      { headers: HEADERS },
    );
  }
  if (request.headers.get("Origin") !== env.APP_ORIGIN) return problem(403, "forbidden");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  try {
    const body = await readBody(request);
    const output = url.pathname.endsWith("/challenge")
      ? await challenge(env, session, body)
      : await register(env, session, body);
    return Response.json(output, {
      status: url.pathname.endsWith("/challenge") ? 201 : 200,
      headers: HEADERS,
    });
  } catch (error) {
    if (error instanceof MutationUnavailableError) return problem(503, "not_ready");
    const code = error instanceof Error ? error.message : "";
    if (code === "encryption_key_exists") return problem(409, "conflict");
    if (code === "encryption_challenge_expired") return problem(403, "forbidden");
    if (code === "encryption_challenge_invalid") return problem(403, "forbidden");
    if (code === "invalid_encryption_key" || code === "invalid_encryption_body")
      return problem(400, "bad_request");
    return problem(503, "not_ready");
  }
}
