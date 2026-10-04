import {
  encryptionHeaderHash,
  type LegacyAdoption,
  legacyAdoptionPayload,
  verifyEncryptionAttestation,
} from "../../../shared/src/encryptionAttestation";
import {
  canonicalSignedHeader,
  parseAndVerifySignedContainerHeader,
  parseSignedContainerHeader,
  type SignedContainerHeader,
  type SignedContainerVerifyOptions,
  serializeSignedContainerHeader,
  signedHeaderPayload,
} from "../../../shared/src/signedContainer";
import {
  type CipherChunkRange,
  createFileCipher,
  decryptPlainRange,
  encryptFileChunks,
  type FileCipher,
  type FileEnvelope,
  iteratePlainRange,
  MAX_CIPHER_BYTES,
  parseFileEnvelope,
  type RecipientPublicKey,
  type UnlockedRecipient,
  unwrapFileCipher,
} from "./cryptoEnvelope";

const MAGIC = new Uint8Array([78, 67, 70, 69, 78, 67, 49, 0]); // NCFENC1\0
const PREFIX_BYTES = 12;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 2048;
const MAX_METADATA_CIPHERTEXT_BYTES = MAX_METADATA_BYTES + 16;
const OPFS_DIRECTORY = "ncf-encrypted-staging-v1";
const OPFS_LOCK = "ncf-encrypted-staging-v1";
const STALE_OPFS_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface EncryptedFileMetadata {
  readonly name: string;
  readonly mime: string;
  readonly lastModified: number;
}
export interface EncryptedMetadata {
  readonly iv: string;
  readonly data: string;
}
export interface ContainerHeader {
  readonly envelope: FileEnvelope;
  readonly encryptedMetadata: EncryptedMetadata;
  readonly headerEnd: number;
  readonly totalBytes: number;
  readonly signed?: SignedContainerHeader;
}
export interface OpenedContainer extends ContainerHeader {
  readonly cipher: FileCipher;
  readonly metadata: EncryptedFileMetadata;
}
export interface ContainerWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<File>;
  discard(): Promise<void>;
}
export type ContainerWriterFactory = (opaqueName: string) => Promise<ContainerWriter>;
export interface CompletedContainer {
  readonly file: File;
  readonly opaqueName: string;
  readonly header: ContainerHeader;
  readonly headerBytes: Uint8Array;
  discard(): Promise<void>;
}

function invalid(): never {
  throw new Error("invalid_encrypted_container");
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
    invalid();
}
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeBase64Url(
  value: unknown,
  lengthMin: number,
  lengthMax: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((lengthMax * 4) / 3) + 3
  )
    invalid();
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (binary.length < lengthMin || binary.length > lengthMax) invalid();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) invalid();
  return bytes;
}
function metadata(value: unknown): EncryptedFileMetadata {
  exactKeys(value, ["name", "mime", "lastModified"]);
  if (
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    encoder.encode(value.name).length > 1024 ||
    /[\x00-\x1f\x7f/\\]/.test(value.name) ||
    typeof value.mime !== "string" ||
    value.mime.length > 128 ||
    !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value.mime) ||
    !Number.isSafeInteger(value.lastModified) ||
    (value.lastModified as number) < 0
  )
    invalid();
  return { name: value.name, mime: value.mime, lastModified: value.lastModified as number };
}
function metadataAad(envelope: FileEnvelope): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    `ncf-file-metadata-v1\0${envelope.cryptoId}\0${envelope.plainSize}\0${envelope.cipherSize}`,
  );
}
function canonicalHeader(
  envelope: FileEnvelope,
  encrypted: EncryptedMetadata,
): Uint8Array<ArrayBuffer> {
  const json = JSON.stringify({
    version: 1,
    envelope: parseFileEnvelope(envelope),
    encryptedMetadata: encrypted,
  });
  const bytes = encoder.encode(json);
  if (bytes.length < 1 || bytes.length > MAX_HEADER_BYTES) invalid();
  return bytes;
}
function encryptedMetadata(value: unknown): EncryptedMetadata {
  exactKeys(value, ["iv", "data"]);
  decodeBase64Url(value.iv, 12, 12);
  decodeBase64Url(value.data, 16, MAX_METADATA_CIPHERTEXT_BYTES);
  return { iv: value.iv as string, data: value.data as string };
}
function prefixLength(bytes: Uint8Array): number {
  if (
    bytes.length !== PREFIX_BYTES ||
    (MAGIC.some((byte, index) => bytes[index] !== byte) &&
      !(
        bytes.subarray(0, 6).every((byte, index) => byte === MAGIC[index]) &&
        bytes[6] === 50 &&
        bytes[7] === 0
      ))
  )
    invalid();
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
  if (length < 1 || length > MAX_HEADER_BYTES) invalid();
  return length;
}
export function readContainerHeaderLength(prefix: Uint8Array): number {
  return prefixLength(prefix);
}

/** Accepts exactly the 12-byte prefix plus the declared JSON bytes, never the body. */
export function parseContainerHeader(prefixAndHeader: Uint8Array): ContainerHeader {
  if (
    prefixAndHeader.length < PREFIX_BYTES ||
    prefixAndHeader.length > PREFIX_BYTES + MAX_HEADER_BYTES
  )
    invalid();
  const length = prefixLength(prefixAndHeader.subarray(0, PREFIX_BYTES));
  if (prefixAndHeader.length !== PREFIX_BYTES + length) invalid();
  if (prefixAndHeader[6] === 50) {
    const signed = parseSignedContainerHeader(prefixAndHeader);
    const envelope = parseFileEnvelope(signed.envelope);
    const encrypted = encryptedMetadata(signed.encryptedMetadata);
    const headerEnd = PREFIX_BYTES + length;
    const totalBytes = headerEnd + envelope.cipherSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CIPHER_BYTES) invalid();
    return { envelope, encryptedMetadata: encrypted, headerEnd, totalBytes, signed };
  }
  const json = decoder.decode(prefixAndHeader.subarray(PREFIX_BYTES));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    invalid();
  }
  exactKeys(parsed, ["version", "envelope", "encryptedMetadata"]);
  if (parsed.version !== 1) invalid();
  const envelope = parseFileEnvelope(parsed.envelope);
  const encrypted = encryptedMetadata(parsed.encryptedMetadata);
  if (decoder.decode(canonicalHeader(envelope, encrypted)) !== json) invalid();
  const headerEnd = PREFIX_BYTES + length;
  const totalBytes = headerEnd + envelope.cipherSize;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CIPHER_BYTES) invalid();
  return { envelope, encryptedMetadata: encrypted, headerEnd, totalBytes };
}

export async function readContainerHeader(file: Blob): Promise<ContainerHeader> {
  const prefix = new Uint8Array(await file.slice(0, PREFIX_BYTES).arrayBuffer());
  const length = readContainerHeaderLength(prefix);
  const headerEnd = PREFIX_BYTES + length;
  if (file.size < headerEnd) invalid();
  const header = parseContainerHeader(new Uint8Array(await file.slice(0, headerEnd).arrayBuffer()));
  if (file.size !== header.totalBytes) invalid();
  return header;
}

async function sealMetadata(
  cipher: FileCipher,
  value: EncryptedFileMetadata,
): Promise<EncryptedMetadata> {
  const normalized = metadata(value);
  const plain = encoder.encode(JSON.stringify(normalized));
  if (plain.length > MAX_METADATA_BYTES) invalid();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: metadataAad(cipher.envelope), tagLength: 128 },
      cipher.key,
      plain,
    ),
  );
  return { iv: encodeBase64Url(iv), data: encodeBase64Url(data) };
}
export async function authenticateContainerMetadata(
  headerValue: ContainerHeader,
  cipher: FileCipher,
): Promise<EncryptedFileMetadata> {
  const header = parseContainerHeader(serializeContainerHeader(headerValue));
  if (header.headerEnd !== headerValue.headerEnd || header.totalBytes !== headerValue.totalBytes)
    invalid();
  if (JSON.stringify(header.envelope) !== JSON.stringify(parseFileEnvelope(cipher.envelope)))
    invalid();
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(header.encryptedMetadata.iv, 12, 12),
        additionalData: metadataAad(header.envelope),
        tagLength: 128,
      },
      cipher.key,
      decodeBase64Url(header.encryptedMetadata.data, 16, MAX_METADATA_CIPHERTEXT_BYTES),
    ),
  );
  if (plain.length > MAX_METADATA_BYTES) invalid();
  const json = decoder.decode(plain);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    invalid();
  }
  const meta = metadata(parsed);
  if (JSON.stringify(meta) !== json) invalid();
  return meta;
}
export async function openContainerHeader(
  headerValue: ContainerHeader,
  unlocked: UnlockedRecipient,
  options: { readonly legacyUnsigned: true },
): Promise<OpenedContainer> {
  if (!options?.legacyUnsigned || headerValue.signed) invalid();
  const header = parseContainerHeader(serializeContainerHeader(headerValue));
  if (header.headerEnd !== headerValue.headerEnd || header.totalBytes !== headerValue.totalBytes)
    invalid();
  const cipher = await unwrapFileCipher(header.envelope, unlocked);
  const meta = await authenticateContainerMetadata(header, cipher);
  return { ...header, cipher, metadata: meta };
}

/** Authenticated app path: caller supplies the trusted owner key and expected identity. */
export async function openAuthenticatedContainerHeader(
  headerValue: ContainerHeader,
  unlocked: UnlockedRecipient,
  options: SignedContainerVerifyOptions,
): Promise<OpenedContainer> {
  if (!headerValue.signed) invalid();
  const bytes = serializeContainerHeader(headerValue);
  await parseAndVerifySignedContainerHeader(bytes, options);
  const header = parseContainerHeader(bytes);
  if (header.headerEnd !== headerValue.headerEnd || header.totalBytes !== headerValue.totalBytes)
    invalid();
  const cipher = await unwrapFileCipher(header.envelope, unlocked);
  const meta = await authenticateContainerMetadata(header, cipher);
  return { ...header, cipher, metadata: meta };
}

export interface AttestedLegacyOpenOptions {
  readonly attestation: LegacyAdoption;
  readonly ownerSignature: string;
  readonly ownerSigningSpki: string;
  readonly expectedOwnerId: string;
  readonly expectedNodeId: string;
  readonly expectedBlobId: string;
  readonly expectedSize: number;
  readonly expectedOwnerFingerprint: string;
  readonly expectedAdminFingerprint: string;
}

/** Existing v1 blobs can open only after a trusted owner approved this exact immutable header. */
export async function openAttestedLegacyContainerHeader(
  headerValue: ContainerHeader,
  unlocked: UnlockedRecipient,
  options: AttestedLegacyOpenOptions,
): Promise<OpenedContainer> {
  if (headerValue.signed) invalid();
  const bytes = serializeContainerHeader(headerValue);
  const header = parseContainerHeader(bytes);
  const claim = options.attestation;
  if (
    header.headerEnd !== headerValue.headerEnd ||
    header.totalBytes !== headerValue.totalBytes ||
    header.totalBytes !== options.expectedSize ||
    claim.ownerId !== options.expectedOwnerId ||
    claim.nodeId !== options.expectedNodeId ||
    claim.blobId !== options.expectedBlobId ||
    claim.cryptoId !== header.envelope.cryptoId ||
    claim.requiredAdminFingerprint !== options.expectedAdminFingerprint ||
    claim.headerSha256 !== (await encryptionHeaderHash(bytes)) ||
    !header.envelope.recipients.some(
      (entry) => entry.fingerprint === options.expectedOwnerFingerprint,
    ) ||
    !header.envelope.recipients.some(
      (entry) => entry.fingerprint === options.expectedAdminFingerprint,
    ) ||
    !(await verifyEncryptionAttestation(
      options.ownerSigningSpki,
      options.ownerSignature,
      legacyAdoptionPayload(claim),
    ))
  )
    invalid();
  const cipher = await unwrapFileCipher(header.envelope, unlocked);
  const meta = await authenticateContainerMetadata(header, cipher);
  return { ...header, cipher, metadata: meta };
}

function serializeContainerHeader(value: ContainerHeader): Uint8Array<ArrayBuffer> {
  if (value.signed) {
    const checked = canonicalSignedHeader(value.signed);
    if (
      JSON.stringify(checked.envelope) !== JSON.stringify(parseFileEnvelope(value.envelope)) ||
      JSON.stringify(checked.encryptedMetadata) !==
        JSON.stringify(encryptedMetadata(value.encryptedMetadata))
    )
      invalid();
    return serializeSignedContainerHeader(checked);
  }
  const header = canonicalHeader(value.envelope, value.encryptedMetadata);
  const bytes = new Uint8Array(PREFIX_BYTES + header.length);
  bytes.set(MAGIC);
  new DataView(bytes.buffer).setUint32(8, header.length, false);
  bytes.set(header, PREFIX_BYTES);
  if (bytes.length + value.envelope.cipherSize > MAX_CIPHER_BYTES) invalid();
  return bytes;
}

export function* planContainerPlainRange(
  header: ContainerHeader,
  offset: number,
  length: number,
): Generator<CipherChunkRange> {
  for (const range of iteratePlainRange(header.envelope, offset, length))
    yield { ...range, cipherOffset: header.headerEnd + range.cipherOffset };
}

export async function* decryptContainerPlainRange(
  opened: OpenedContainer,
  offset: number,
  length: number,
  fetchCipherChunk: (range: CipherChunkRange) => Promise<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield* decryptPlainRange(opened.cipher, offset, length, (range) =>
    fetchCipherChunk({ ...range, cipherOffset: opened.headerEnd + range.cipherOffset }),
  );
}

/** Browser OPFS writer. No plaintext is written to OPFS. */
export async function createOpfsContainerWriter(opaqueName: string): Promise<ContainerWriter> {
  if (!/^[A-Za-z0-9_-]{22}\.ncf$/.test(opaqueName) || !navigator.storage?.getDirectory) invalid();
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
  try {
    await directory.getFileHandle(opaqueName);
    invalid(); // Never truncate an existing completed or interrupted ciphertext file.
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
  const handle = await directory.getFileHandle(opaqueName, { create: true });
  let stream: FileSystemWritableFileStream;
  try {
    stream = await handle.createWritable({ keepExistingData: false });
  } catch (error) {
    await directory.removeEntry(opaqueName).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    async write(bytes) {
      if (closed) invalid();
      await stream.write(new Uint8Array(bytes));
    },
    async close() {
      if (closed) invalid();
      await stream.close();
      closed = true;
      return handle.getFile();
    },
    async discard() {
      if (!closed) {
        closed = true;
        await stream.abort().catch(() => undefined);
      }
      await directory.removeEntry(opaqueName).catch((error: unknown) => {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
      });
    },
  };
}

/** Produces a complete immutable ciphertext File for the existing upload manager. */
export async function createEncryptedContainer(
  source: File,
  recipients: readonly RecipientPublicKey[],
  writerFactory: ContainerWriterFactory = createOpfsContainerWriter,
  signal?: AbortSignal,
  options?:
    | { readonly ownerId: string; readonly signer: UnlockedRecipient["signing"] }
    | { readonly legacyUnsigned: true },
): Promise<CompletedContainer> {
  signal?.throwIfAborted();
  const cipher = await createFileCipher(source.size, recipients);
  signal?.throwIfAborted();
  const opaqueName = `${cipher.envelope.cryptoId}.ncf`;
  const claimedMime = source.type.toLowerCase();
  // Chromium reports local .m4a files as audio/x-m4a; browser media playback uses audio/mp4.
  // This is a display hint inside authenticated metadata, never a server-side content assertion.
  const displayMime =
    claimedMime === "audio/x-m4a" || claimedMime === "audio/m4a" ? "audio/mp4" : claimedMime;
  const encrypted = await sealMetadata(cipher, {
    name: source.name,
    mime: /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(displayMime)
      ? displayMime
      : "application/octet-stream",
    lastModified: source.lastModified,
  });
  let headerBytes: Uint8Array<ArrayBuffer>;
  if (options && "legacyUnsigned" in options && options.legacyUnsigned) {
    const legacy = canonicalHeader(cipher.envelope, encrypted);
    headerBytes = new Uint8Array(PREFIX_BYTES + legacy.length);
    headerBytes.set(MAGIC);
    new DataView(headerBytes.buffer).setUint32(8, legacy.length, false);
    headerBytes.set(legacy, PREFIX_BYTES);
  } else if (options && "ownerId" in options) {
    const { ownerId, signer } = options;
    const unsigned = canonicalSignedHeader({
      version: 2,
      envelope: cipher.envelope,
      encryptedMetadata: encrypted,
      ownerId,
      signer: { fingerprint: signer.fingerprint, spki: signer.spki },
      signature: encodeBase64Url(new Uint8Array(64)),
    });
    if (
      signer.privateKey.extractable ||
      signer.privateKey.type !== "private" ||
      signer.privateKey.algorithm.name !== "Ed25519"
    )
      invalid();
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        signer.privateKey,
        signedHeaderPayload(unsigned),
      ),
    );
    headerBytes = serializeSignedContainerHeader({
      ...unsigned,
      signature: encodeBase64Url(signature),
    });
    await parseAndVerifySignedContainerHeader(headerBytes, {
      expectedOwnerId: ownerId,
      expectedSize: headerBytes.length + cipher.envelope.cipherSize,
      ownerSigningSpki: signer.spki,
      requiredOwnerFingerprint: cipher.envelope.recipients[0]!.fingerprint,
      requiredAdminFingerprint: cipher.envelope.recipients.at(-1)!.fingerprint,
    });
  } else invalid();
  const header = parseContainerHeader(headerBytes);
  const produce = async (): Promise<CompletedContainer> => {
    const writer = await writerFactory(opaqueName);
    try {
      signal?.throwIfAborted();
      await writer.write(headerBytes);
      for await (const chunk of encryptFileChunks(source, cipher)) {
        signal?.throwIfAborted();
        await writer.write(chunk);
      }
      signal?.throwIfAborted();
      const file = await writer.close();
      signal?.throwIfAborted();
      if (file.size !== header.totalBytes || file.name !== opaqueName) invalid();
      return { file, opaqueName, header, headerBytes, discard: () => writer.discard() };
    } catch (error) {
      await writer.discard().catch(() => undefined);
      throw error;
    }
  };
  // Cleanup and every browser OPFS writer share one cross-tab lock. Test writers remain injectable.
  if (writerFactory !== createOpfsContainerWriter) return produce();
  if (!navigator.locks) throw new Error("opfs_lock_unavailable");
  return navigator.locks.request(OPFS_LOCK, signal ? { signal } : {}, produce);
}

/** Reclaim only abandoned ciphertext. Call after loading all persisted upload references. */
export async function cleanupStaleOpfsContainers(
  referenced: ReadonlySet<string>,
  now = Date.now(),
): Promise<number> {
  if (!navigator.storage?.getDirectory || !navigator.locks) return 0;
  if (!Number.isSafeInteger(now)) invalid();
  return navigator.locks.request(OPFS_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return 0;
    const root = await navigator.storage.getDirectory();
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await root.getDirectoryHandle(OPFS_DIRECTORY);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return 0;
      throw error;
    }
    let removed = 0;
    // The File System Access API defines keys(), but TypeScript's DOM lib omits the mixin.
    const entries = directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for await (const name of entries.keys()) {
      if (!/^[A-Za-z0-9_-]{22}\.ncf$/.test(name) || referenced.has(name)) continue;
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        if (file.lastModified > now - STALE_OPFS_MS) continue;
        await directory.removeEntry(name);
        removed++;
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
      }
    }
    return removed;
  });
}

export async function discardOpfsContainerFile(opaqueName: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{22}\.ncf$/.test(opaqueName) || !navigator.storage?.getDirectory) invalid();
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_DIRECTORY);
  await directory.removeEntry(opaqueName);
}

/** Open only a previously recorded completed OPFS ciphertext; never recreate it with the same DEK. */
export async function reopenOpfsContainerFile(
  opaqueName: string,
): Promise<{ file: File; header: ContainerHeader }> {
  if (!/^[A-Za-z0-9_-]{22}\.ncf$/.test(opaqueName) || !navigator.storage?.getDirectory) invalid();
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_DIRECTORY);
  const file = await (await directory.getFileHandle(opaqueName)).getFile();
  const header = await readContainerHeader(file);
  if (`${header.envelope.cryptoId}.ncf` !== opaqueName) invalid();
  return { file, header };
}
