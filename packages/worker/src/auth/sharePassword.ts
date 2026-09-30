import { base64url } from "jose";
import type { KdfDeriver } from "./globalKdf";
import { KdfUnavailableError, runKdf } from "./kdf";

const KEY = /^[A-Za-z0-9_-]{43}$/;
const SALT = /^[A-Za-z0-9_-]{22}$/;
const MAX_PASSWORD_BYTES = 1024;

export interface SharePasswordPepperRing {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly derive: KdfDeriver;
}

export interface SharePasswordRecord {
  readonly passwordDigest: string;
  readonly salt: string;
  readonly kdf: "PBKDF2-SHA256";
  readonly kdfParams: string;
  readonly kid: string;
}

export async function sharePasswordPepperRing(
  activeKid: string,
  keys: Readonly<Record<string, string>>,
  derive: KdfDeriver,
): Promise<SharePasswordPepperRing> {
  if (
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 3 ||
    !Object.hasOwn(keys, activeKid)
  )
    throw new Error("invalid_share_password_peppers");
  const imported = new Map<string, CryptoKey>();
  for (const [kid, encoded] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !KEY.test(encoded))
      throw new Error("invalid_share_password_peppers");
    const bytes = base64url.decode(encoded);
    if (bytes.length !== 32 || base64url.encode(bytes) !== encoded)
      throw new Error("invalid_share_password_peppers");
    imported.set(
      kid,
      await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
    );
  }
  if (typeof derive !== "function") throw new Error("kdf_backend_required");
  return { activeKid, keys: imported, derive };
}

function passwordBytes(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password);
  if (bytes.length < 1 || bytes.length > MAX_PASSWORD_BYTES)
    throw new Error("invalid_share_password");
  return bytes;
}

async function digest(
  password: string,
  salt: Uint8Array,
  pepper: CryptoKey,
  derive: KdfDeriver,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (salt.length !== 16) throw new Error("invalid_share_password_salt");
  const bytes = passwordBytes(password);
  return runKdf(async () => {
    let peppered: ArrayBuffer;
    try {
      peppered = await crypto.subtle.sign("HMAC", pepper, bytes);
    } finally {
      bytes.fill(0);
    }
    try {
      const result = new Uint8Array(await derive(peppered, salt, signal));
      if (result.length !== 32) throw new KdfUnavailableError();
      return result;
    } finally {
      new Uint8Array(peppered).fill(0);
    }
  }, signal);
}

export async function hashSharePassword(
  password: string,
  ring: SharePasswordPepperRing,
  signal?: AbortSignal,
): Promise<SharePasswordRecord> {
  const pepper = ring.keys.get(ring.activeKid);
  if (!pepper) throw new Error("invalid_share_password_peppers");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    passwordDigest: base64url.encode(await digest(password, salt, pepper, ring.derive, signal)),
    salt: base64url.encode(salt),
    kdf: "PBKDF2-SHA256",
    kdfParams: '{"iterations":100000}',
    kid: ring.activeKid,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function verifySharePassword(
  password: string,
  record: SharePasswordRecord,
  ring: SharePasswordPepperRing,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    record.kdf !== "PBKDF2-SHA256" ||
    record.kdfParams !== '{"iterations":100000}' ||
    !SALT.test(record.salt) ||
    !KEY.test(record.passwordDigest)
  )
    return false;
  const pepper = ring.keys.get(record.kid);
  if (!pepper) return false;
  try {
    const salt = base64url.decode(record.salt);
    const expected = base64url.decode(record.passwordDigest);
    return (
      base64url.encode(salt) === record.salt &&
      base64url.encode(expected) === record.passwordDigest &&
      equalBytes(await digest(password, salt, pepper, ring.derive, signal), expected)
    );
  } catch (error) {
    if (error instanceof KdfUnavailableError) throw error;
    return false;
  }
}
