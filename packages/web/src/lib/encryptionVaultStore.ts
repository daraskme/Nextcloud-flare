import type { RecipientPublicKey, RecipientVault } from "./cryptoEnvelope";
import type { EncryptionSession } from "./encryptionSession";

export const MAX_ENCRYPTION_FILE_BYTES = 16 * 1024;
const DATABASE_NAME = "ncf-encryption-vaults";
const DATABASE_VERSION = 4;
const SESSION_STORE_NAME = "unlocked-sessions";
const VAULT_STORE_NAME = "recipient-vaults";
const ADMIN_KEY_STORE_NAME = "admin-recipients";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface RecoveryFile {
  readonly version: 1;
  readonly accountId: string;
  readonly recipientVault: RecipientVault;
  readonly recoveryKey: string;
}

interface StoredVault {
  readonly accountId: string;
  readonly vault: RecipientVault;
}

export interface PinnedAdminRecipient {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly recipient: RecipientPublicKey;
  readonly signer: RecipientPublicKey;
}

interface StoredAdminRecipient extends PinnedAdminRecipient {}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...expected].sort().join(","),
  );
}

function validAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

export function parseRecoveryFile(json: string, expectedAccountId: string): RecoveryFile {
  try {
    if (
      !validAccountId(expectedAccountId) ||
      new TextEncoder().encode(json).byteLength > MAX_ENCRYPTION_FILE_BYTES
    )
      throw new Error();
    const value: unknown = JSON.parse(json);
    if (!exactKeys(value, ["version", "accountId", "recipientVault", "recoveryKey"]))
      throw new Error();
    if (
      value.version !== 1 ||
      value.accountId !== expectedAccountId ||
      typeof value.recoveryKey !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.recoveryKey) ||
      !validVault(value.recipientVault, expectedAccountId)
    )
      throw new Error();
    return value as unknown as RecoveryFile;
  } catch {
    throw new Error("invalid_encryption_recovery_file");
  }
}

export function recoveryFileJson(
  accountId: string,
  recipientVault: RecipientVault,
  recoveryKey: string,
): string {
  if (
    !validAccountId(accountId) ||
    !validVault(recipientVault, accountId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)
  )
    throw new Error("invalid_encryption_recovery_file");
  const json = JSON.stringify({ version: 1, accountId, recipientVault, recoveryKey });
  if (new TextEncoder().encode(json).byteLength > MAX_ENCRYPTION_FILE_BYTES)
    throw new Error("invalid_encryption_recovery_file");
  return json;
}

export function publicKeyFileJson(accountId: string, recipient: RecipientPublicKey): string {
  if (
    !validAccountId(accountId) ||
    !exactKeys(recipient, ["fingerprint", "spki"]) ||
    typeof recipient.fingerprint !== "string" ||
    typeof recipient.spki !== "string"
  )
    throw new Error("invalid_encryption_public_key");
  const json = JSON.stringify({ version: 1, accountId, recipient });
  if (new TextEncoder().encode(json).byteLength > MAX_ENCRYPTION_FILE_BYTES)
    throw new Error("invalid_encryption_public_key");
  return json;
}

export async function parsePublicKeyFile(
  json: string,
  expectedCurrentAccountId: string,
): Promise<{ accountId: string; recipient: RecipientPublicKey }> {
  try {
    if (
      !validAccountId(expectedCurrentAccountId) ||
      new TextEncoder().encode(json).byteLength > MAX_ENCRYPTION_FILE_BYTES
    )
      throw new Error();
    const value: unknown = JSON.parse(json);
    if (
      !exactKeys(value, ["version", "accountId", "recipient"]) ||
      value.version !== 1 ||
      !validAccountId(value.accountId) ||
      value.accountId === expectedCurrentAccountId ||
      !validRecipient(value.recipient)
    )
      throw new Error();
    const recipient = value.recipient as RecipientPublicKey;
    await verifyRecipientPublicKey(recipient);
    return { accountId: value.accountId, recipient };
  } catch {
    throw new Error("invalid_encryption_public_key_file");
  }
}

export async function verifyRecipientPublicKey(recipient: RecipientPublicKey): Promise<void> {
  try {
    if (!validRecipient(recipient)) throw new Error();
    const fingerprintBytes = new Uint8Array(decodeBase64Url(recipient.fingerprint, 32, 32));
    const spkiBytes = new Uint8Array(decodeBase64Url(recipient.spki, 300, 800));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spkiBytes));
    if (digest.some((byte, index) => byte !== fingerprintBytes[index])) throw new Error();
    const key = await crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["wrapKey", "encrypt"],
    );
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
    if (algorithm.modulusLength !== 3072 || algorithm.hash.name !== "SHA-256") throw new Error();
  } catch {
    throw new Error("invalid_encryption_public_key_file");
  }
}

export class EncryptionVaultStore {
  readonly #factory: Pick<IDBFactory, "open">;
  #database: Promise<IDBDatabase> | null = null;

  constructor(factory: Pick<IDBFactory, "open"> = indexedDB) {
    this.#factory = factory;
  }

  getSession(accountId: string) {
    return this.#request<
      { accountId: string; epoch: number; session: EncryptionSession } | undefined
    >(SESSION_STORE_NAME, "readonly", (store) => store.get(accountId));
  }

  putSession(accountId: string, epoch: number, session: EncryptionSession) {
    return this.#request<void>(SESSION_STORE_NAME, "readwrite", (store) =>
      store.put({ accountId, epoch, session }),
    );
  }

  clearSessions() {
    return this.#request<void>(SESSION_STORE_NAME, "readwrite", (store) => store.clear());
  }

  async get(accountId: string): Promise<RecipientVault | null> {
    if (!validAccountId(accountId)) throw new Error("encryption_storage_unavailable");
    try {
      const record = await this.#request<StoredVault | undefined>(
        VAULT_STORE_NAME,
        "readonly",
        (store) => store.get(accountId),
      );
      if (record === undefined) return null;
      if (
        !exactKeys(record, ["accountId", "vault"]) ||
        record.accountId !== accountId ||
        !validVault(record.vault, accountId)
      )
        throw new Error();
      return structuredClone(record.vault);
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  async put(accountId: string, vault: RecipientVault): Promise<void> {
    if (!validAccountId(accountId) || !validVault(vault, accountId))
      throw new Error("invalid_encryption_vault");
    const record: StoredVault = { accountId, vault: structuredClone(vault) };
    try {
      await this.#request<void>(VAULT_STORE_NAME, "readwrite", (store) => store.put(record));
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  async delete(accountId: string): Promise<void> {
    if (!validAccountId(accountId)) throw new Error("encryption_storage_unavailable");
    try {
      await this.#request<void>(VAULT_STORE_NAME, "readwrite", (store) => store.delete(accountId));
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  async getPinnedAdminRecipient(accountId: string): Promise<PinnedAdminRecipient | null> {
    if (!validAccountId(accountId)) throw new Error("encryption_storage_unavailable");
    try {
      const record = await this.#request<StoredAdminRecipient | undefined>(
        ADMIN_KEY_STORE_NAME,
        "readonly",
        (store) => store.get(accountId),
      );
      if (record === undefined) return null;
      // Previous local pins contained only the RSA recipient key. They are not
      // sufficient to authenticate signed container headers; discard and re-pin.
      if (
        record &&
        typeof record === "object" &&
        !Object.hasOwn(record, "signer") &&
        record.accountId === accountId
      ) {
        await this.#request<void>(ADMIN_KEY_STORE_NAME, "readwrite", (store) =>
          store.delete(accountId),
        );
        return null;
      }
      if (
        !exactKeys(record, ["accountId", "adminAccountId", "recipient", "signer"]) ||
        record.accountId !== accountId ||
        !validAccountId(record.adminAccountId) ||
        record.adminAccountId === accountId ||
        !validRecipient(record.recipient) ||
        !validSigningKey(record.signer)
      )
        throw new Error();
      await verifyRecipientPublicKey(record.recipient);
      await verifySigningPublicKey(record.signer);
      return structuredClone(record);
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  async pinAdminRecipient(
    accountId: string,
    adminAccountId: string,
    recipient: RecipientPublicKey,
    signer: RecipientPublicKey,
  ): Promise<void> {
    if (
      !validAccountId(accountId) ||
      !validAccountId(adminAccountId) ||
      accountId === adminAccountId ||
      !validRecipient(recipient) ||
      !validSigningKey(signer)
    )
      throw new Error("invalid_encryption_public_key");
    await verifyRecipientPublicKey(recipient);
    await verifySigningPublicKey(signer);
    const record: StoredAdminRecipient = { accountId, adminAccountId, recipient, signer };
    try {
      await this.#request<void>(ADMIN_KEY_STORE_NAME, "readwrite", (store) => store.put(record));
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  async deletePinnedAdminRecipient(accountId: string): Promise<void> {
    if (!validAccountId(accountId)) throw new Error("encryption_storage_unavailable");
    try {
      await this.#request<void>(ADMIN_KEY_STORE_NAME, "readwrite", (store) =>
        store.delete(accountId),
      );
    } catch {
      throw new Error("encryption_storage_unavailable");
    }
  }

  #open(): Promise<IDBDatabase> {
    return (this.#database ??= new Promise((resolve, reject) => {
      try {
        const request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(SESSION_STORE_NAME))
            request.result.createObjectStore(SESSION_STORE_NAME, { keyPath: "accountId" });
          if (!request.result.objectStoreNames.contains(VAULT_STORE_NAME))
            request.result.createObjectStore(VAULT_STORE_NAME, { keyPath: "accountId" });
          if (!request.result.objectStoreNames.contains(ADMIN_KEY_STORE_NAME))
            request.result.createObjectStore(ADMIN_KEY_STORE_NAME, { keyPath: "accountId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = request.onblocked = () =>
          reject(new Error("encryption_storage_unavailable"));
      } catch {
        reject(new Error("encryption_storage_unavailable"));
      }
    }));
  }

  async #request<T>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const database = await this.#open();
    return new Promise<T>((resolve, reject) => {
      try {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        let result: unknown;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(new Error("encryption_storage_unavailable"));
        transaction.oncomplete = () => resolve(result as T);
        transaction.onerror = transaction.onabort = () =>
          reject(new Error("encryption_storage_unavailable"));
      } catch {
        reject(new Error("encryption_storage_unavailable"));
      }
    });
  }
}

function validRecipient(value: unknown): value is RecipientPublicKey {
  return (
    exactKeys(value, ["fingerprint", "spki"]) &&
    typeof value.fingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.fingerprint) &&
    typeof value.spki === "string" &&
    /^[A-Za-z0-9_-]{400,1100}$/.test(value.spki)
  );
}

function validSigningKey(value: unknown): value is RecipientPublicKey {
  return (
    exactKeys(value, ["fingerprint", "spki"]) &&
    typeof value.fingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.fingerprint) &&
    typeof value.spki === "string" &&
    /^[A-Za-z0-9_-]{54,110}$/.test(value.spki)
  );
}

async function verifySigningPublicKey(key: RecipientPublicKey): Promise<void> {
  const spki = decodeBase64Url(key.spki, 40, 80);
  const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(spki)));
  let binary = "";
  for (const byte of fingerprint) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (encoded !== key.fingerprint) throw new Error("invalid_encryption_public_key");
  try {
    await crypto.subtle.importKey("spki", new Uint8Array(spki), { name: "Ed25519" }, false, [
      "verify",
    ]);
  } catch {
    throw new Error("invalid_encryption_public_key");
  }
}

function decodeBase64Url(
  value: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_encryption_public_key_file");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (binary.length < minBytes || binary.length > maxBytes)
    throw new Error("invalid_encryption_public_key_file");
  const bytes = new Uint8Array(Array.from(binary, (character) => character.charCodeAt(0)));
  let canonical = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000)
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  const encoded = btoa(canonical).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (encoded !== value) throw new Error("invalid_encryption_public_key_file");
  return bytes;
}

function validVault(value: unknown, accountId: string): value is RecipientVault {
  if (
    !exactKeys(value, ["version", "accountId", "recipient", "salt", "iv", "encryptedPkcs8"]) ||
    value.version !== 1 ||
    value.accountId !== accountId ||
    !exactKeys(value.recipient, ["fingerprint", "spki"])
  )
    return false;
  return (
    [
      value.recipient.fingerprint,
      value.recipient.spki,
      value.salt,
      value.iv,
      value.encryptedPkcs8,
    ].every((field) => typeof field === "string" && field.length > 0 && field.length <= 8192) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ENCRYPTION_FILE_BYTES
  );
}
