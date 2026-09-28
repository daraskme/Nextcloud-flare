import { validSharePassword } from "@next-cloud-flare/shared/linkShares";
import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";
import type { KdfDeriver } from "./globalKdf";
import { KdfUnavailableError, runKdf } from "./kdf";

export interface SharePasswordRing extends ContentKeyRing {
  readonly derive: KdfDeriver;
}
export interface SharePasswordRecord {
  passwordDigest: string;
  salt: string;
  kdf: "PBKDF2-SHA256";
  kdfParams: string;
  kid: string;
}
const PARAMS = '{"iterations":100000}';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
export function newShareSecret(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}
/** High-entropy URL capabilities are bound to one share; only their SHA-256 digest is stored. */
export async function shareSecretDigest(id: string, secret: string): Promise<string> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    !SECRET.test(secret) ||
    base64url.encode(base64url.decode(secret)) !== secret
  )
    throw new Error("invalid_share_secret");
  return base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(["ncf-share-secret-v1", id, secret])),
      ),
    ),
  );
}
async function derivePassword(
  id: string,
  password: string,
  salt: Uint8Array,
  key: CryptoKey,
  derive: KdfDeriver,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !validSharePassword(password) || salt.length !== 16)
    throw new Error("invalid_share_request");
  return runKdf(async () => {
    const input = new TextEncoder().encode(JSON.stringify(["ncf-share-password-v1", id, password]));
    const peppered = await crypto.subtle.sign("HMAC", key, input);
    input.fill(0);
    try {
      const result = await derive(peppered, salt, signal);
      if (result.byteLength !== 32) throw new KdfUnavailableError();
      return new Uint8Array(result);
    } finally {
      new Uint8Array(peppered).fill(0);
    }
  }, signal);
}
export async function hashSharePassword(
  id: string,
  password: string,
  ring: SharePasswordRing,
  signal?: AbortSignal,
): Promise<SharePasswordRecord> {
  const key = ring.keys.get(ring.activeKid);
  if (!key) throw new Error("share_password_unavailable");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    passwordDigest: base64url.encode(
      await derivePassword(id, password, salt, key, ring.derive, signal),
    ),
    salt: base64url.encode(salt),
    kdf: "PBKDF2-SHA256",
    kdfParams: PARAMS,
    kid: ring.activeKid,
  };
}
export async function matchesSharePassword(
  id: string,
  password: string,
  saved: SharePasswordRecord,
  ring: SharePasswordRing,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = ring.keys.get(saved.kid);
  if (
    !key ||
    saved.kdf !== "PBKDF2-SHA256" ||
    saved.kdfParams !== PARAMS ||
    !/^[A-Za-z0-9_-]{22}$/.test(saved.salt) ||
    !SECRET.test(saved.passwordDigest)
  )
    return false;
  try {
    const salt = base64url.decode(saved.salt),
      expected = base64url.decode(saved.passwordDigest);
    if (
      salt.length !== 16 ||
      expected.length !== 32 ||
      base64url.encode(salt) !== saved.salt ||
      base64url.encode(expected) !== saved.passwordDigest
    )
      return false;
    const actual = await derivePassword(id, password, salt, key, ring.derive, signal);
    let difference = 0;
    for (let i = 0; i < 32; i++) difference |= actual[i]! ^ expected[i]!;
    actual.fill(0);
    return difference === 0;
  } catch (error) {
    if (error instanceof KdfUnavailableError) throw error;
    return false;
  }
}
