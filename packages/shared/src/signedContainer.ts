/** Bounded, canonical NCFENC2 header. This module is shared by browser and Worker. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAGIC = new Uint8Array([78, 67, 70, 69, 78, 67, 50, 0]);
const LEGACY_MAGIC = new Uint8Array([78, 67, 70, 69, 78, 67, 49, 0]);
const DOMAIN = encoder.encode("ncf-container-header-v2\0");
const MAX_HEADER = 16 * 1024;
const MAX_CIPHER = 536_870_912_000;
const CHUNK = 4 * 1024 * 1024;
const fail = (): never => {
  throw new Error("invalid_signed_container");
};

export interface SignedContainerHeader {
  readonly version: 2;
  readonly envelope: {
    readonly version: 1;
    readonly cryptoId: string;
    readonly plainSize: number;
    readonly chunkBytes: typeof CHUNK;
    readonly cipherSize: number;
    readonly recipients: readonly { readonly fingerprint: string; readonly wrappedKey: string }[];
  };
  readonly encryptedMetadata: { readonly iv: string; readonly data: string };
  readonly ownerId: string;
  readonly signer: { readonly fingerprint: string; readonly spki: string };
  readonly signature: string;
}
export interface SignedContainerVerification {
  readonly headerSha256: string;
  readonly cryptoId: string;
  readonly recipientFingerprints: readonly string[];
  readonly signerFingerprint: string;
}
export interface SignedContainerVerifyOptions {
  readonly expectedOwnerId: string;
  readonly expectedSize: number;
  readonly ownerSigningSpki: string;
  readonly requiredOwnerFingerprint: string;
  readonly requiredAdminFingerprint: string;
  readonly expectedHeaderSha256?: string;
}
export interface LegacyContainerHeader {
  readonly envelope: SignedContainerHeader["envelope"];
  readonly encryptedMetadata: SignedContainerHeader["encryptedMetadata"];
  readonly headerEnd: number;
  readonly totalBytes: number;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
}
export function encodeSignedBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeSignedBase64(
  value: unknown,
  min: number,
  max: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((max * 4) / 3) + 3
  )
    fail();
  let binary: string;
  try {
    binary = atob((value as string).replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return fail();
  }
  if (binary.length < min || binary.length > max) fail();
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (encodeSignedBase64(bytes) !== value) fail();
  return bytes;
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail();
  return value as number;
}
function parseEnvelope(value: unknown): SignedContainerHeader["envelope"] {
  exact(value, ["version", "cryptoId", "plainSize", "chunkBytes", "cipherSize", "recipients"]);
  if (value.version !== 1 || value.chunkBytes !== CHUNK) fail();
  decodeSignedBase64(value.cryptoId, 16, 16);
  const plainSize = integer(value.plainSize, MAX_CIPHER);
  const chunks = Math.max(1, Math.ceil(plainSize / CHUNK));
  const cipherSize = plainSize + 28 * chunks;
  if (
    cipherSize > MAX_CIPHER ||
    value.cipherSize !== cipherSize ||
    !Array.isArray(value.recipients) ||
    value.recipients.length < 1 ||
    value.recipients.length > 32
  )
    fail();
  let previous = "";
  const recipients = (value.recipients as unknown[]).map((entry: unknown) => {
    exact(entry, ["fingerprint", "wrappedKey"]);
    decodeSignedBase64(entry.fingerprint, 32, 32);
    decodeSignedBase64(entry.wrappedKey, 384, 384);
    if ((entry.fingerprint as string) <= previous) fail();
    previous = entry.fingerprint as string;
    return { fingerprint: entry.fingerprint as string, wrappedKey: entry.wrappedKey as string };
  });
  return {
    version: 1,
    cryptoId: value.cryptoId as string,
    plainSize,
    chunkBytes: CHUNK,
    cipherSize,
    recipients,
  };
}
export function canonicalSignedHeader(value: unknown): SignedContainerHeader {
  exact(value, ["version", "envelope", "encryptedMetadata", "ownerId", "signer", "signature"]);
  if (
    value.version !== 2 ||
    typeof value.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.ownerId)
  )
    fail();
  const envelope = parseEnvelope(value.envelope);
  exact(value.encryptedMetadata, ["iv", "data"]);
  decodeSignedBase64(value.encryptedMetadata.iv, 12, 12);
  decodeSignedBase64(value.encryptedMetadata.data, 16, 2064);
  exact(value.signer, ["fingerprint", "spki"]);
  decodeSignedBase64(value.signer.fingerprint, 32, 32);
  decodeSignedBase64(value.signer.spki, 40, 80);
  decodeSignedBase64(value.signature, 64, 64);
  return {
    version: 2,
    envelope,
    encryptedMetadata: {
      iv: value.encryptedMetadata.iv as string,
      data: value.encryptedMetadata.data as string,
    },
    ownerId: value.ownerId as string,
    signer: { fingerprint: value.signer.fingerprint as string, spki: value.signer.spki as string },
    signature: value.signature as string,
  };
}
export function signedHeaderPayload(header: SignedContainerHeader): Uint8Array<ArrayBuffer> {
  const checked = canonicalSignedHeader(header);
  const json = encoder.encode(
    JSON.stringify({
      version: 2,
      envelope: checked.envelope,
      encryptedMetadata: checked.encryptedMetadata,
      ownerId: checked.ownerId,
      signer: checked.signer,
    }),
  );
  const result = new Uint8Array(DOMAIN.length + json.length);
  result.set(DOMAIN);
  result.set(json, DOMAIN.length);
  return result;
}
export function serializeSignedContainerHeader(
  header: SignedContainerHeader,
): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(canonicalSignedHeader(header)));
  if (!json.length || json.length > MAX_HEADER) fail();
  const bytes = new Uint8Array(12 + json.length);
  bytes.set(MAGIC);
  new DataView(bytes.buffer).setUint32(8, json.length, false);
  bytes.set(json, 12);
  if (bytes.length + header.envelope.cipherSize > MAX_CIPHER) fail();
  return bytes;
}
export function parseSignedContainerHeader(prefixAndHeader: Uint8Array): SignedContainerHeader {
  if (
    prefixAndHeader.length < 13 ||
    prefixAndHeader.length > 12 + MAX_HEADER ||
    MAGIC.some((byte, i) => prefixAndHeader[i] !== byte)
  )
    fail();
  const length = new DataView(prefixAndHeader.buffer, prefixAndHeader.byteOffset, 12).getUint32(
    8,
    false,
  );
  if (length < 1 || length > MAX_HEADER || prefixAndHeader.length !== 12 + length) fail();
  let parsed: unknown;
  const json = decoder.decode(prefixAndHeader.subarray(12));
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail();
  }
  const header = canonicalSignedHeader(parsed);
  if (decoder.decode(serializeSignedContainerHeader(header).subarray(12)) !== json) fail();
  return header;
}
/** Strict v1 parser for signed adoption. Parsing alone grants no authenticity. */
export function parseLegacyContainerHeader(prefixAndHeader: Uint8Array): LegacyContainerHeader {
  if (
    prefixAndHeader.length < 13 ||
    prefixAndHeader.length > 12 + MAX_HEADER ||
    LEGACY_MAGIC.some((byte, i) => prefixAndHeader[i] !== byte)
  )
    fail();
  const length = new DataView(prefixAndHeader.buffer, prefixAndHeader.byteOffset, 12).getUint32(
    8,
    false,
  );
  if (length < 1 || length > MAX_HEADER || prefixAndHeader.length !== 12 + length) fail();
  const json = decoder.decode(prefixAndHeader.subarray(12));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail();
  }
  exact(parsed, ["version", "envelope", "encryptedMetadata"]);
  if (parsed.version !== 1) fail();
  const envelope = parseEnvelope(parsed.envelope);
  exact(parsed.encryptedMetadata, ["iv", "data"]);
  decodeSignedBase64(parsed.encryptedMetadata.iv, 12, 12);
  decodeSignedBase64(parsed.encryptedMetadata.data, 16, 2064);
  const encryptedMetadata = {
    iv: parsed.encryptedMetadata.iv as string,
    data: parsed.encryptedMetadata.data as string,
  };
  if (JSON.stringify({ version: 1, envelope, encryptedMetadata }) !== json) fail();
  const totalBytes = prefixAndHeader.length + envelope.cipherSize;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CIPHER) fail();
  return { envelope, encryptedMetadata, headerEnd: prefixAndHeader.length, totalBytes };
}
export async function signedContainerFingerprint(spki: Uint8Array): Promise<string> {
  return encodeSignedBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(spki))),
  );
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function parseAndVerifySignedContainerHeader(
  prefixAndHeader: Uint8Array,
  options: SignedContainerVerifyOptions,
): Promise<SignedContainerVerification> {
  const header = parseSignedContainerHeader(prefixAndHeader);
  if (
    header.ownerId !== options.expectedOwnerId ||
    !Number.isSafeInteger(options.expectedSize) ||
    prefixAndHeader.length + header.envelope.cipherSize !== options.expectedSize
  )
    fail();
  const pinned = decodeSignedBase64(options.ownerSigningSpki, 40, 80);
  const signer = decodeSignedBase64(header.signer.spki, 40, 80);
  if (encodeSignedBase64(pinned) !== header.signer.spki) fail();
  const signerFingerprint = await signedContainerFingerprint(signer);
  if (signerFingerprint !== header.signer.fingerprint) fail();
  for (const required of [options.requiredOwnerFingerprint, options.requiredAdminFingerprint]) {
    decodeSignedBase64(required, 32, 32);
    if (!header.envelope.recipients.some((entry) => entry.fingerprint === required)) fail();
  }
  const headerSha256 = hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(prefixAndHeader))),
  );
  if (
    options.expectedHeaderSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(options.expectedHeaderSha256)
  )
    fail();
  if (options.expectedHeaderSha256 !== undefined && options.expectedHeaderSha256 !== headerSha256)
    fail();
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", signer, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return fail();
  }
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeSignedBase64(header.signature, 64, 64),
      signedHeaderPayload(header),
    ))
  )
    fail();
  return {
    headerSha256,
    cryptoId: header.envelope.cryptoId,
    recipientFingerprints: header.envelope.recipients.map((entry) => entry.fingerprint),
    signerFingerprint,
  };
}
