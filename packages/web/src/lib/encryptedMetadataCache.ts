import { encryptionHeaderHash } from "../../../shared/src/encryptionAttestation";
import type { Account, FileNode } from "./api";
import { openAuthenticatedContainerHeader, parseContainerHeader } from "./encryptedContainer";
import { type EncryptionSession, getEncryptionSession } from "./encryptionSession";

type Metadata = Pick<FileNode, "name" | "mime" | "size">;
const STORE = "headers";
const MAX_HEADERS = 1000;
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ncf-encrypted-metadata", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("savedAt", "savedAt");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => reject(new Error("metadata_cache_unavailable"));
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

const key = (account: Pick<Account, "id" | "epoch">, hash: string) =>
  JSON.stringify([account.id, account.epoch, hash]);

/** Store only the signed, encrypted container header; never persist a plaintext filename or key. */
export async function cacheEncryptedHeader(
  account: Pick<Account, "id" | "epoch">,
  headerBytes: Uint8Array,
): Promise<void> {
  try {
    if (headerBytes.length > 16 * 1024 + 12 || !parseContainerHeader(headerBytes).signed) return;
    const id = key(account, await encryptionHeaderHash(new Uint8Array(headerBytes)));
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.put({ id, savedAt: Date.now(), headerBytes: new Uint8Array(headerBytes) });
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_HEADERS;
        if (excess <= 0) return;
        const oldest = store.index("savedAt").openCursor();
        oldest.onsuccess = () => {
          if (!oldest.result || excess-- <= 0) return;
          oldest.result.delete();
          oldest.result.continue();
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("metadata_cache_unavailable"));
    });
  } catch {
    // Optional local acceleration; storage failure must not prevent upload or reading.
  }
}

/** Bind a cached header to the current listing, account, registered keys and unlocked recipient. */
export async function openCachedMetadata(
  account: Account,
  node: FileNode,
  keys: EncryptionSession,
  headerBytes: Uint8Array,
): Promise<Metadata | null> {
  const marker = node.encryption;
  if (
    !marker ||
    marker.formatVersion !== 2 ||
    marker.ownerId !== account.id ||
    !keys.ownerRegistered ||
    !node.currentBlobId ||
    !Number.isSafeInteger(node.size) ||
    marker.signerRsaFingerprint !== keys.owner.publicKey.fingerprint ||
    marker.signerFingerprint !== keys.owner.signing.fingerprint ||
    marker.requiredAdminFingerprint !== keys.adminRecipient?.fingerprint
  )
    return null;
  const header = parseContainerHeader(headerBytes);
  if (header.envelope.cryptoId !== marker.cryptoId) return null;
  const opened = await openAuthenticatedContainerHeader(header, keys.owner, {
    expectedOwnerId: account.id,
    expectedSize: node.size!,
    ownerSigningSpki: keys.owner.signing.spki,
    requiredOwnerFingerprint: marker.signerRsaFingerprint,
    requiredAdminFingerprint: marker.requiredAdminFingerprint,
    expectedHeaderSha256: marker.headerSha256,
  });
  return {
    name: opened.metadata.name,
    mime: opened.metadata.mime,
    size: opened.envelope.plainSize,
  };
}

export async function cachedFileMetadata(
  account: Account,
  node: FileNode,
): Promise<Metadata | null> {
  const keys = getEncryptionSession(account.id);
  if (!keys || !node.encryption) return null;
  try {
    const db = await open();
    const record = await new Promise<{ headerBytes: Uint8Array } | undefined>((resolve, reject) => {
      const request = db
        .transaction(STORE)
        .objectStore(STORE)
        .get(key(account, node.encryption!.headerSha256));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("metadata_cache_unavailable"));
    });
    if (!(record?.headerBytes instanceof Uint8Array)) return null;
    const result = await openCachedMetadata(account, node, keys, record.headerBytes);
    return getEncryptionSession(account.id) === keys ? result : null;
  } catch {
    // Corrupt, obsolete, or unavailable cache entries fall back to the authenticated source.
    return null;
  }
}
