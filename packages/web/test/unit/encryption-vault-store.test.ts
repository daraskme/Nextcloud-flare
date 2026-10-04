import { describe, expect, it } from "vitest";
import { createRecipientVault, type RecipientVault } from "../../src/lib/cryptoEnvelope";
import {
  EncryptionVaultStore,
  parsePublicKeyFile,
  parseRecoveryFile,
  publicKeyFileJson,
  type RecoveryFile,
  recoveryFileJson,
} from "../../src/lib/encryptionVaultStore";

function fixture(accountId: string): RecipientVault {
  return {
    version: 1,
    accountId,
    recipient: { fingerprint: "fingerprint-public-only", spki: "public-key-only" },
    salt: "salt-public-to-vault",
    iv: "iv-public-to-vault",
    encryptedPkcs8: "encrypted-private-key-ciphertext",
  };
}

function memoryIndexedDb() {
  const records = new Map<string, Map<string, unknown>>();
  const database = {
    objectStoreNames: { contains: (name: string) => records.has(name) },
    createObjectStore: (name: string) => {
      const table = new Map<string, unknown>();
      records.set(name, table);
      return table;
    },
    transaction: (storeName: string) => {
      const table = records.get(storeName)!;
      const objectStore = {
        get(key: string) {
          const request: Record<string, unknown> = {};
          queueMicrotask(() => {
            request.result = structuredClone(table.get(key));
            (request.onsuccess as (() => void) | undefined)?.();
          });
          return request;
        },
        put(value: { accountId: string }) {
          table.set(value.accountId, structuredClone(value));
          const request: Record<string, unknown> = {};
          queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
          return request;
        },
        delete(key: string) {
          table.delete(key);
          const request: Record<string, unknown> = {};
          queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
          return request;
        },
      };
      const transaction: Record<string, unknown> = {
        objectStore: () => objectStore,
      };
      setTimeout(() => (transaction.oncomplete as (() => void) | undefined)?.(), 0);
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const request: Record<string, unknown> = { result: database };
      queueMicrotask(() => {
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, records };
}

describe("local recipient vault storage", () => {
  it("isolates saved vaults by account and deletes only the selected account", async () => {
    const indexed = memoryIndexedDb();
    const store = new EncryptionVaultStore(indexed.factory);
    const owner = fixture("owner_1");
    const admin = fixture("admin_1");
    await store.put(owner.accountId, owner);
    await store.put(admin.accountId, admin);

    expect(await store.get(owner.accountId)).toEqual(owner);
    expect(await store.get(admin.accountId)).toEqual(admin);
    await store.delete(owner.accountId);
    expect(await store.get(owner.accountId)).toBeNull();
    expect(await store.get(admin.accountId)).toEqual(admin);
  });

  it("persists only the encrypted vault record, never the recovery key or unlocked key", async () => {
    const indexed = memoryIndexedDb();
    const store = new EncryptionVaultStore(indexed.factory);
    const vault = fixture("user_2");
    const recoveryKey = "R".repeat(43);
    const file = JSON.parse(recoveryFileJson(vault.accountId, vault, recoveryKey)) as RecoveryFile;
    await store.put(vault.accountId, file.recipientVault);

    const stored = indexed.records.get("recipient-vaults")?.get(vault.accountId);
    expect(stored).toEqual({ accountId: vault.accountId, vault });
    expect(JSON.stringify(stored)).not.toContain(recoveryKey);
    expect(Object.keys(stored as object).sort()).toEqual(["accountId", "vault"]);
    expect(JSON.stringify(stored)).not.toContain('"privateKey"');
  });

  it("strictly validates recovery files, account binding, exact fields and size before unlock", () => {
    const vault = fixture("owner_3");
    const recoveryKey = "A".repeat(43);
    const json = recoveryFileJson(vault.accountId, vault, recoveryKey);
    expect(parseRecoveryFile(json, vault.accountId)).toMatchObject({
      version: 1,
      accountId: vault.accountId,
      recoveryKey,
    });
    expect(() => parseRecoveryFile(json, "different_account")).toThrow(
      "invalid_encryption_recovery_file",
    );
    expect(() =>
      parseRecoveryFile(`${json.slice(0, -1)},"unexpected":true}`, vault.accountId),
    ).toThrow("invalid_encryption_recovery_file");
    expect(() => parseRecoveryFile(`${json}${" ".repeat(16 * 1024)}`, vault.accountId)).toThrow(
      "invalid_encryption_recovery_file",
    );
    expect(() => recoveryFileJson(vault.accountId, vault, "short")).toThrow();
  });

  it("exports a separate public-only key file", () => {
    const vault = fixture("admin_4");
    const recoveryKey = "S".repeat(43);
    const publicJson = publicKeyFileJson(vault.accountId, vault.recipient);
    expect(JSON.parse(publicJson)).toEqual({
      version: 1,
      accountId: vault.accountId,
      recipient: vault.recipient,
    });
    expect(publicJson).not.toContain(recoveryKey);
    expect(publicJson).not.toContain("encryptedPkcs8");
    expect(publicJson).not.toContain("privateKey");
  });

  it("validates and pins an out-of-band admin public key per account only", async () => {
    const indexed = memoryIndexedDb();
    const store = new EncryptionVaultStore(indexed.factory);
    const admin = await createRecipientVault("admin_5");
    const keyFile = publicKeyFileJson("admin_5", admin.unlocked.publicKey);
    expect(await parsePublicKeyFile(keyFile, "member_5")).toEqual({
      accountId: "admin_5",
      recipient: admin.unlocked.publicKey,
    });
    const signer = {
      fingerprint: admin.unlocked.signing.fingerprint,
      spki: admin.unlocked.signing.spki,
    };
    await store.pinAdminRecipient("member_5", "admin_5", admin.unlocked.publicKey, signer);
    expect(await store.getPinnedAdminRecipient("member_5")).toEqual({
      accountId: "member_5",
      adminAccountId: "admin_5",
      recipient: admin.unlocked.publicKey,
      signer,
    });
    expect(await store.getPinnedAdminRecipient("member_6")).toBeNull();
    const stored = indexed.records.get("admin-recipients")?.get("member_5");
    expect(JSON.stringify(stored)).not.toContain(admin.recoveryKey);
    expect(JSON.stringify(stored)).not.toContain("encryptedPkcs8");
    expect(JSON.stringify(stored)).not.toContain("privateKey");

    const tampered = {
      ...admin.unlocked.publicKey,
      fingerprint: `${admin.unlocked.publicKey.fingerprint[0] === "A" ? "B" : "A"}${admin.unlocked.publicKey.fingerprint.slice(1)}`,
    };
    await expect(
      parsePublicKeyFile(publicKeyFileJson("admin_5", tampered), "member_5"),
    ).rejects.toThrow("invalid_encryption_public_key_file");
    await expect(parsePublicKeyFile(keyFile, "admin_5")).rejects.toThrow(
      "invalid_encryption_public_key_file",
    );
    await expect(
      parsePublicKeyFile(`${keyFile}${" ".repeat(16 * 1024)}`, "member_5"),
    ).rejects.toThrow("invalid_encryption_public_key_file");
  }, 30_000);
});
