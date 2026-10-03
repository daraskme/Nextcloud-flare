/** Client-only envelope used by encrypted uploads and local media decryption. */
export const ENVELOPE_VERSION = 1 as const;
export const PLAIN_CHUNK_BYTES = 4 * 1024 * 1024;
export const TRANSPORT_PART_BYTES = 64 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHUNK_OVERHEAD = IV_BYTES + TAG_BYTES;
const MAX_PLAIN_BYTES = 536_870_912_000;
export const MAX_CIPHER_BYTES = 536_870_912_000;
const MAX_EAGER_RANGE_CHUNKS = 16;
const encoder = new TextEncoder();
type OwnedBytes = Uint8Array<ArrayBuffer>;

export interface RecipientPublicKey {
  readonly fingerprint: string;
  readonly spki: string;
}
export interface WrappedRecipientKey {
  readonly fingerprint: string;
  readonly wrappedKey: string;
}
export interface FileEnvelope {
  readonly version: 1;
  readonly cryptoId: string;
  readonly plainSize: number;
  readonly chunkBytes: typeof PLAIN_CHUNK_BYTES;
  readonly cipherSize: number;
  readonly recipients: readonly WrappedRecipientKey[];
}
export interface RecipientVault {
  readonly version: 1;
  readonly accountId: string;
  readonly recipient: RecipientPublicKey;
  readonly salt: string;
  readonly iv: string;
  readonly encryptedPkcs8: string;
}
export interface UnlockedRecipient {
  readonly publicKey: RecipientPublicKey;
  readonly privateKey: CryptoKey;
}
export interface FileCipher {
  readonly envelope: FileEnvelope;
  readonly key: CryptoKey;
}
export interface CipherChunkRange {
  readonly index: number;
  readonly cipherOffset: number;
  readonly cipherLength: number;
  readonly plainOffset: number;
  readonly plainLength: number;
  readonly takeOffset: number;
  readonly takeLength: number;
}

function fail(): never {
  throw new Error("invalid_encryption_envelope");
}
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlToBytes(value: unknown, min: number, max: number): OwnedBytes {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((max * 4) / 3) + 3
  )
    return fail();
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (binary.length < min || binary.length > max) return fail();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) return fail();
  return bytes;
}
function exactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
}
function size(value: unknown, max = MAX_PLAIN_BYTES): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail();
  return value as number;
}
function accountId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail();
  return value;
}
function random(length: number): OwnedBytes {
  return crypto.getRandomValues(new Uint8Array(length));
}
async function fingerprint(spki: OwnedBytes): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
}
function recipient(value: unknown): RecipientPublicKey {
  exactKeys(value, ["fingerprint", "spki"]);
  const spki = base64UrlToBytes(value.spki, 300, 800);
  base64UrlToBytes(value.fingerprint, 32, 32);
  return { fingerprint: value.fingerprint as string, spki: value.spki as string };
}
async function importPublic(value: RecipientPublicKey): Promise<CryptoKey> {
  const checked = recipient(value);
  const spki = base64UrlToBytes(checked.spki, 300, 800);
  if ((await fingerprint(spki)) !== checked.fingerprint) fail();
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["wrapKey", "encrypt"],
  );
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (algorithm.modulusLength !== 3072 || algorithm.hash.name !== "SHA-256") fail();
  return key;
}
function label(cryptoId: string, recipientFingerprint: string): OwnedBytes {
  return encoder.encode(`ncf-file-key-v1\0${cryptoId}\0${recipientFingerprint}`);
}
function vaultAad(account: string, value: RecipientPublicKey): OwnedBytes {
  return encoder.encode(`ncf-recipient-vault-v1\0${account}\0${value.fingerprint}\0${value.spki}`);
}
async function vaultKey(recovery: OwnedBytes, salt: OwnedBytes): Promise<CryptoKey> {
  if (recovery.length !== 32 || salt.length !== 16) fail();
  const source = await crypto.subtle.importKey("raw", recovery, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("ncf-recipient-vault-key-v1") },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The recovery secret is returned once; neither vault nor private key is sent to a Worker. */
export async function createRecipientVault(accountValue: string): Promise<{
  vault: RecipientVault;
  recoveryKey: string;
  unlocked: UnlockedRecipient;
}> {
  const account = accountId(accountValue);
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", generated.publicKey));
  const publicKey = { fingerprint: await fingerprint(spki), spki: bytesToBase64Url(spki) };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  const recovery = random(32);
  const salt = random(16);
  const iv = random(IV_BYTES);
  try {
    const key = await vaultKey(recovery, salt);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: vaultAad(account, publicKey), tagLength: 128 },
        key,
        pkcs8,
      ),
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["unwrapKey", "decrypt"],
    );
    return {
      vault: {
        version: 1,
        accountId: account,
        recipient: publicKey,
        salt: bytesToBase64Url(salt),
        iv: bytesToBase64Url(iv),
        encryptedPkcs8: bytesToBase64Url(encrypted),
      },
      recoveryKey: bytesToBase64Url(recovery),
      unlocked: { publicKey, privateKey },
    };
  } finally {
    pkcs8.fill(0);
    recovery.fill(0);
  }
}

export async function unlockRecipientVault(
  vaultValue: unknown,
  recoveryValue: string,
  expectedAccountId: string,
): Promise<UnlockedRecipient> {
  exactKeys(vaultValue, ["version", "accountId", "recipient", "salt", "iv", "encryptedPkcs8"]);
  if (vaultValue.version !== 1) fail();
  const account = accountId(vaultValue.accountId);
  if (account !== accountId(expectedAccountId)) fail();
  const publicKey = recipient(vaultValue.recipient);
  const publicCryptoKey = await importPublic(publicKey);
  const recovery = base64UrlToBytes(recoveryValue, 32, 32);
  const salt = base64UrlToBytes(vaultValue.salt, 16, 16);
  const iv = base64UrlToBytes(vaultValue.iv, IV_BYTES, IV_BYTES);
  const encrypted = base64UrlToBytes(vaultValue.encryptedPkcs8, 1000, 4096);
  let pkcs8: OwnedBytes | undefined;
  try {
    const key = await vaultKey(recovery, salt);
    pkcs8 = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: vaultAad(account, publicKey), tagLength: 128 },
        key,
        encrypted,
      ),
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["unwrapKey", "decrypt"],
    );
    const challenge = random(32);
    const encryptedChallenge = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicCryptoKey,
      challenge,
    );
    const found = new Uint8Array(
      await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedChallenge),
    );
    if (found.length !== challenge.length || found.some((byte, index) => byte !== challenge[index]))
      fail();
    return { publicKey, privateKey };
  } finally {
    recovery.fill(0);
    pkcs8?.fill(0);
  }
}

export function chunkCount(plainSize: number): number {
  size(plainSize);
  return Math.max(1, Math.ceil(plainSize / PLAIN_CHUNK_BYTES));
}
export function cipherSize(plainSize: number): number {
  const result = plainSize + chunkCount(plainSize) * CHUNK_OVERHEAD;
  if (result > MAX_CIPHER_BYTES) fail();
  return result;
}
export function parseFileEnvelope(value: unknown): FileEnvelope {
  exactKeys(value, ["version", "cryptoId", "plainSize", "chunkBytes", "cipherSize", "recipients"]);
  if (value.version !== 1 || value.chunkBytes !== PLAIN_CHUNK_BYTES) fail();
  base64UrlToBytes(value.cryptoId, 16, 16);
  const plainSize = size(value.plainSize);
  if (
    value.cipherSize !== cipherSize(plainSize) ||
    !Array.isArray(value.recipients) ||
    value.recipients.length < 1 ||
    value.recipients.length > 32
  )
    fail();
  const seen = new Set<string>();
  const recipients = value.recipients.map((entry: unknown) => {
    exactKeys(entry, ["fingerprint", "wrappedKey"]);
    base64UrlToBytes(entry.fingerprint, 32, 32);
    base64UrlToBytes(entry.wrappedKey, 384, 384);
    const fingerprint = entry.fingerprint as string;
    if (seen.has(fingerprint)) fail();
    seen.add(fingerprint);
    return { fingerprint, wrappedKey: entry.wrappedKey as string };
  });
  if (
    recipients.some(
      (entry, index) => index > 0 && recipients[index - 1]!.fingerprint >= entry.fingerprint,
    )
  )
    fail();
  return {
    version: 1,
    cryptoId: value.cryptoId as string,
    plainSize,
    chunkBytes: PLAIN_CHUNK_BYTES,
    cipherSize: value.cipherSize as number,
    recipients,
  };
}

export async function createFileCipher(
  plainSize: number,
  recipients: readonly RecipientPublicKey[],
): Promise<FileCipher> {
  size(plainSize);
  if (recipients.length < 1 || recipients.length > 32) fail();
  const cryptoId = bytesToBase64Url(random(16));
  const raw = random(32);
  const seen = new Set<string>();
  try {
    const wrapped: WrappedRecipientKey[] = [];
    for (const value of recipients) {
      const publicKey = await importPublic(value);
      if (seen.has(value.fingerprint)) fail();
      seen.add(value.fingerprint);
      const bytes = await crypto.subtle.encrypt(
        { name: "RSA-OAEP", label: label(cryptoId, value.fingerprint) },
        publicKey,
        raw,
      );
      wrapped.push({
        fingerprint: value.fingerprint,
        wrappedKey: bytesToBase64Url(new Uint8Array(bytes)),
      });
    }
    wrapped.sort((a, b) =>
      a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
    );
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return {
      envelope: parseFileEnvelope({
        version: 1,
        cryptoId,
        plainSize,
        chunkBytes: PLAIN_CHUNK_BYTES,
        cipherSize: cipherSize(plainSize),
        recipients: wrapped,
      }),
      key,
    };
  } finally {
    raw.fill(0);
  }
}

export async function unwrapFileCipher(
  value: unknown,
  unlocked: UnlockedRecipient,
): Promise<FileCipher> {
  const envelope = parseFileEnvelope(value);
  const publicKey = recipient(unlocked.publicKey);
  const found = envelope.recipients.find((entry) => entry.fingerprint === publicKey.fingerprint);
  if (!found || unlocked.privateKey.extractable || unlocked.privateKey.type !== "private") fail();
  await importPublic(publicKey);
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: label(envelope.cryptoId, publicKey.fingerprint) },
      unlocked.privateKey,
      base64UrlToBytes(found.wrappedKey, 384, 384),
    ),
  );
  try {
    if (raw.length !== 32) fail();
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return { envelope, key };
  } finally {
    raw.fill(0);
  }
}

function chunkPlainLength(envelope: FileEnvelope, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount(envelope.plainSize)) fail();
  return Math.min(PLAIN_CHUNK_BYTES, envelope.plainSize - index * PLAIN_CHUNK_BYTES);
}
function chunkAad(envelope: FileEnvelope, index: number, length: number): OwnedBytes {
  const bytes = new Uint8Array(4 + 1 + 16 + 8 + 4 + 4 + 4);
  bytes.set(encoder.encode("NCFE"));
  bytes[4] = ENVELOPE_VERSION;
  bytes.set(base64UrlToBytes(envelope.cryptoId, 16, 16), 5);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(21, BigInt(envelope.plainSize));
  view.setUint32(29, index);
  view.setUint32(33, chunkCount(envelope.plainSize));
  view.setUint32(37, length);
  return bytes;
}
function assertKey(key: CryptoKey): void {
  if (
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    key.extractable ||
    (key.algorithm as AesKeyAlgorithm).length !== 256
  )
    fail();
}
export async function encryptChunk(
  cipher: FileCipher,
  index: number,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseFileEnvelope(cipher.envelope);
  assertKey(cipher.key);
  if (plain.length !== chunkPlainLength(envelope, index)) fail();
  const iv = random(IV_BYTES);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: chunkAad(envelope, index, plain.length),
        tagLength: 128,
      },
      cipher.key,
      new Uint8Array(plain),
    ),
  );
  const result = new Uint8Array(IV_BYTES + encrypted.length);
  result.set(iv);
  result.set(encrypted, IV_BYTES);
  return result;
}
export async function decryptChunk(
  cipher: FileCipher,
  index: number,
  encoded: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseFileEnvelope(cipher.envelope);
  assertKey(cipher.key);
  const length = chunkPlainLength(envelope, index);
  if (encoded.length !== length + CHUNK_OVERHEAD) fail();
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(encoded.subarray(0, IV_BYTES)),
        additionalData: chunkAad(envelope, index, length),
        tagLength: 128,
      },
      cipher.key,
      new Uint8Array(encoded.subarray(IV_BYTES)),
    ),
  );
}

/** One pass only: a retry must persist ciphertext or begin a new file key/upload. */
export async function* encryptFileChunks(
  file: Blob,
  cipher: FileCipher,
): AsyncGenerator<Uint8Array> {
  const envelope = parseFileEnvelope(cipher.envelope);
  if (file.size !== envelope.plainSize) fail();
  for (let index = 0; index < chunkCount(envelope.plainSize); index++) {
    const offset = index * PLAIN_CHUNK_BYTES;
    yield encryptChunk(
      cipher,
      index,
      new Uint8Array(
        await file.slice(offset, offset + chunkPlainLength(envelope, index)).arrayBuffer(),
      ),
    );
  }
}

/** Consuming the iterator to completion is required to reject a missing final chunk. */
export async function* decryptFileChunks(
  chunks: AsyncIterable<Uint8Array>,
  cipher: FileCipher,
): AsyncGenerator<Uint8Array> {
  const envelope = parseFileEnvelope(cipher.envelope);
  let index = 0;
  let received = 0;
  for await (const chunk of chunks) {
    if (index >= chunkCount(envelope.plainSize)) fail();
    received += chunk.length;
    if (received > envelope.cipherSize) fail();
    yield await decryptChunk(cipher, index++, chunk);
  }
  if (index !== chunkCount(envelope.plainSize) || received !== envelope.cipherSize) fail();
}

/** Produces bounded transport parts without buffering the whole file. */
export async function* partitionCipherChunks(
  chunks: AsyncIterable<Uint8Array>,
  expectedSize: number,
  partBytes = TRANSPORT_PART_BYTES,
): AsyncGenerator<Uint8Array> {
  size(expectedSize, MAX_CIPHER_BYTES);
  if (
    !Number.isSafeInteger(partBytes) ||
    partBytes < PLAIN_CHUNK_BYTES ||
    partBytes > TRANSPORT_PART_BYTES
  )
    fail();
  let part = new Uint8Array(Math.min(partBytes, expectedSize));
  let used = 0;
  let total = 0;
  for await (const chunk of chunks) {
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.length < CHUNK_OVERHEAD ||
      chunk.length > PLAIN_CHUNK_BYTES + CHUNK_OVERHEAD ||
      total + chunk.length > expectedSize
    )
      fail();
    let cursor = 0;
    while (cursor < chunk.length) {
      const count = Math.min(part.length - used, chunk.length - cursor);
      part.set(chunk.subarray(cursor, cursor + count), used);
      used += count;
      cursor += count;
      total += count;
      if (used === part.length) {
        yield part;
        part = new Uint8Array(Math.min(partBytes, expectedSize - total));
        used = 0;
      }
    }
  }
  if (total !== expectedSize || used !== 0 || part.length !== 0) fail();
}

export function* iteratePlainRange(
  value: unknown,
  offset: number,
  length: number,
): Generator<CipherChunkRange> {
  const envelope = parseFileEnvelope(value);
  size(offset, envelope.plainSize);
  size(length, envelope.plainSize - offset);
  if (envelope.plainSize === 0) {
    yield {
      index: 0,
      cipherOffset: 0,
      cipherLength: CHUNK_OVERHEAD,
      plainOffset: 0,
      plainLength: 0,
      takeOffset: 0,
      takeLength: 0,
    };
    return;
  }
  if (length === 0) return;
  const start = Math.floor(offset / PLAIN_CHUNK_BYTES);
  const end = Math.floor((offset + length - 1) / PLAIN_CHUNK_BYTES);
  for (let index = start; index <= end; index++) {
    const plainOffset = index * PLAIN_CHUNK_BYTES;
    const plainLength = chunkPlainLength(envelope, index);
    const takeOffset = Math.max(offset, plainOffset) - plainOffset;
    yield {
      index,
      cipherOffset: index * (PLAIN_CHUNK_BYTES + CHUNK_OVERHEAD),
      cipherLength: plainLength + CHUNK_OVERHEAD,
      plainOffset,
      plainLength,
      takeOffset,
      takeLength: Math.min(plainLength - takeOffset, offset + length - plainOffset - takeOffset),
    };
  }
}

/** Small eager windows only; full downloads use the lazy iterator. */
export function planPlainRange(value: unknown, offset: number, length: number): CipherChunkRange[] {
  const envelope = parseFileEnvelope(value);
  size(offset, envelope.plainSize);
  size(length, envelope.plainSize - offset);
  if (length > MAX_EAGER_RANGE_CHUNKS * PLAIN_CHUNK_BYTES) fail();
  return [...iteratePlainRange(envelope, offset, length)];
}

/** Caller fetches only the exact ciphertext ranges. Keep one plaintext chunk in memory. */
export async function* decryptPlainRange(
  cipher: FileCipher,
  offset: number,
  length: number,
  fetchChunk: (range: CipherChunkRange) => Promise<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for (const range of iteratePlainRange(cipher.envelope, offset, length)) {
    const plain = await decryptChunk(cipher, range.index, await fetchChunk(range));
    yield plain.subarray(range.takeOffset, range.takeOffset + range.takeLength);
  }
}
