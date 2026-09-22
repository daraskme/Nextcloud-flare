import { base64url } from "jose";
import { assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Principal } from "./authorize";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const ID = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/;
const ITERATIONS = 100_000;
const MAX_BASIC_BYTES = 512;

export interface AppPasswordPepperRing {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

export async function appPasswordPepperRing(
  activeKid: string,
  keys: Readonly<Record<string, string>>,
): Promise<AppPasswordPepperRing> {
  if (
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 3 ||
    !Object.hasOwn(keys, activeKid)
  )
    throw new Error("invalid_app_password_peppers");
  const imported = new Map<string, CryptoKey>();
  for (const [kid, encoded] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !SECRET.test(encoded))
      throw new Error("invalid_app_password_peppers");
    const bytes = base64url.decode(encoded);
    if (bytes.length !== 32 || base64url.encode(bytes) !== encoded)
      throw new Error("invalid_app_password_peppers");
    imported.set(
      kid,
      await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
    );
  }
  return { activeKid, keys: imported };
}

function secretBytes(secret: string): Uint8Array {
  if (!SECRET.test(secret)) throw new Error("invalid_app_password_secret");
  const bytes = base64url.decode(secret);
  if (bytes.length !== 32 || base64url.encode(bytes) !== secret)
    throw new Error("invalid_app_password_secret");
  return bytes;
}

async function digest(secret: string, salt: Uint8Array, pepper: CryptoKey): Promise<Uint8Array> {
  secretBytes(secret);
  if (salt.length !== 16) throw new Error("invalid_app_password_salt");
  const peppered = await crypto.subtle.sign("HMAC", pepper, new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      key,
      256,
    ),
  );
}

export async function hashAppPassword(
  secret: string,
  ring: AppPasswordPepperRing,
): Promise<{
  secretDigest: string;
  salt: string;
  kdf: "PBKDF2-SHA256";
  kdfParams: string;
  kid: string;
}> {
  const pepper = ring.keys.get(ring.activeKid);
  if (!pepper) throw new Error("invalid_app_password_peppers");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    secretDigest: base64url.encode(await digest(secret, salt, pepper)),
    salt: base64url.encode(salt),
    kdf: "PBKDF2-SHA256",
    kdfParams: '{"iterations":100000}',
    kid: ring.activeKid,
  };
}

function basicCredentials(request: Request, appOrigin: string): { id: string; secret: string } {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.origin !== appOrigin ||
    request.headers.has("Origin") ||
    request.headers.has("Cf-Access-Jwt-Assertion")
  )
    throw new Error("app_password_denied");
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Basic ")) throw new Error("app_password_denied");
  const encoded = authorization.slice(6);
  if (
    encoded.length > 684 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw new Error("app_password_denied");
  let decoded: string;
  try {
    decoded = atob(encoded);
    if (btoa(decoded) !== encoded || decoded.length > MAX_BASIC_BYTES)
      throw new Error("app_password_denied");
  } catch {
    throw new Error("app_password_denied");
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) throw new Error("app_password_denied");
  let id: string;
  let secret: string;
  try {
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const pair = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    id = pair.slice(0, separator);
    secret = pair.slice(separator + 1);
    secretBytes(secret);
  } catch {
    throw new Error("app_password_denied");
  }
  if (!ID.test(id)) throw new Error("app_password_denied");
  return { id, secret };
}

interface PasswordRow {
  user_id: string;
  credential_id: string;
  secret_digest: string;
  salt: string;
  kdf: string;
  kdf_params: string;
  kid: string;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

async function livePasswordRow(
  db: D1Database,
  id: string,
  epoch: number,
): Promise<PasswordRow | null> {
  return primary(db)
    .prepare(`SELECT ap.user_id,c.id AS credential_id,ap.secret_digest,ap.salt,ap.kdf,ap.kdf_params,ap.kid
      FROM app_passwords ap JOIN credentials c ON c.app_password_id=ap.id AND c.kind='app_password'
      JOIN users u ON u.id=ap.user_id JOIN control ctl ON ctl.singleton=1
      WHERE ap.id=? AND ap.revoked_at IS NULL AND ap.expires_at>strftime('%s','now')*1000
        AND u.disabled_at IS NULL AND ctl.epoch=? AND ctl.maintenance=0`)
    .bind(id, epoch)
    .first<PasswordRow>();
}

async function matchesSecret(
  row: PasswordRow,
  secret: string,
  ring: AppPasswordPepperRing,
): Promise<boolean> {
  if (row.kdf !== "PBKDF2-SHA256" || row.kdf_params !== '{"iterations":100000}') return false;
  const pepper = ring.keys.get(row.kid);
  if (!pepper || !/^[A-Za-z0-9_-]{22}$/.test(row.salt) || !SECRET.test(row.secret_digest))
    return false;
  try {
    const salt = base64url.decode(row.salt);
    const expected = base64url.decode(row.secret_digest);
    return (
      base64url.encode(salt) === row.salt &&
      base64url.encode(expected) === row.secret_digest &&
      equalBytes(await digest(secret, salt, pepper), expected)
    );
  } catch {
    return false;
  }
}

/** Authenticate a DAV Basic credential; route admission and rate limiting precede this call. */
export async function authenticateAppPassword(
  db: D1Database,
  request: Request,
  appOrigin: string,
  epoch: number,
  ring: AppPasswordPepperRing,
): Promise<Principal> {
  const { id, secret } = basicCredentials(request, appOrigin);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("app_password_denied");
  const row = await livePasswordRow(db, id, epoch);
  if (!row || !(await matchesSecret(row, secret, ring))) throw new Error("app_password_denied");
  let finalRow = row;
  if (row.kid !== ring.activeKid) {
    const rotated = await hashAppPassword(secret, ring);
    try {
      await atomicBatch(db, [
        {
          sql: `UPDATE app_passwords SET secret_digest=?,salt=?,kid=?
            WHERE id=? AND secret_digest=? AND salt=? AND kid=?
              AND revoked_at IS NULL AND expires_at>strftime('%s','now')*1000
              AND EXISTS(SELECT 1 FROM credentials c JOIN users u ON u.id=app_passwords.user_id
                WHERE c.app_password_id=app_passwords.id AND c.id=? AND c.kind='app_password'
                  AND u.id=? AND u.disabled_at IS NULL)
              AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)`,
          values: [
            rotated.secretDigest,
            rotated.salt,
            rotated.kid,
            id,
            row.secret_digest,
            row.salt,
            row.kid,
            row.credential_id,
            row.user_id,
            epoch,
          ],
        },
        assertOneChange,
      ]);
    } catch {
      // A concurrent login or lost D1 acknowledgement can still have rotated this record.
    }
    const refreshed = await livePasswordRow(db, id, epoch);
    if (
      !refreshed ||
      refreshed.credential_id !== row.credential_id ||
      refreshed.user_id !== row.user_id ||
      refreshed.kid !== ring.activeKid ||
      !(await matchesSecret(refreshed, secret, ring))
    )
      throw new Error("app_password_denied");
    finalRow = refreshed;
  }
  const current = await primary(db)
    .prepare(`SELECT 1 FROM app_passwords ap
      JOIN credentials c ON c.app_password_id=ap.id AND c.kind='app_password'
      JOIN users u ON u.id=ap.user_id JOIN control ctl ON ctl.singleton=1
      WHERE ap.id=? AND c.id=? AND ap.user_id=? AND ap.secret_digest=? AND ap.salt=? AND ap.kid=?
        AND ap.revoked_at IS NULL AND ap.expires_at>strftime('%s','now')*1000
        AND u.disabled_at IS NULL AND ctl.epoch=? AND ctl.maintenance=0`)
    .bind(
      id,
      finalRow.credential_id,
      finalRow.user_id,
      finalRow.secret_digest,
      finalRow.salt,
      finalRow.kid,
      epoch,
    )
    .first<number>();
  if (current === null) throw new Error("app_password_denied");
  return Object.freeze({
    kind: "app_password",
    user_id: finalRow.user_id,
    credential_id: finalRow.credential_id,
    epoch,
  });
}
