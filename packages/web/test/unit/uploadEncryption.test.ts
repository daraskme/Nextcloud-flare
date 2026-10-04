import { afterEach, expect, it, vi } from "vitest";
import type { Account, FileNode } from "../../src/lib/api";

const mocked = vi.hoisted(() => ({
  configured: vi.fn<() => Promise<boolean>>(),
  session: vi.fn(),
  create: vi.fn(),
  reopen: vi.fn(),
  discard: vi.fn(),
  cleanup: vi.fn(),
  save: vi.fn(),
  stored: vi.fn(),
  fingerprint: vi.fn(),
  request: vi.fn(),
  json: vi.fn(),
}));
vi.mock("../../src/lib/encryptionSession", () => ({
  encryptionConfigured: mocked.configured,
  getEncryptionSession: mocked.session,
  isEncryptedFile: (node: FileNode) => node.encryption != null,
}));
vi.mock("../../src/lib/encryptedContainer", () => ({
  cleanupStaleOpfsContainers: mocked.cleanup,
  createEncryptedContainer: mocked.create,
  reopenOpfsContainerFile: mocked.reopen,
  discardOpfsContainerFile: mocked.discard,
}));
vi.mock("../../src/lib/uploadStore", () => ({
  fingerprint: mocked.fingerprint,
  saveUpload: mocked.save,
  removeUpload: vi.fn(),
  storedUploads: mocked.stored,
  clearUploads: vi.fn(),
}));
vi.mock("../../src/lib/api", () => ({
  ApiError: class extends Error {},
  api: { request: mocked.request, json: mocked.json },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : "error"),
}));

import { UploadManager } from "../../src/features/uploads/manager";

const account = { id: "owner_user", epoch: 1, spaceId: "space", rootNodeId: "root" } as Account;
afterEach(() => vi.resetAllMocks());

it("refuses plaintext upload when local encryption is configured but keys are locked", async () => {
  mocked.configured.mockResolvedValue(true);
  mocked.session.mockReturnValue(null);
  const manager = new UploadManager();
  const file = new File(["private bytes"], "private.txt", { type: "text/plain" });
  await expect(manager.enqueue(file, account, "root")).rejects.toThrow("暗号化鍵がロック");
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.request).not.toHaveBeenCalled();
  expect(mocked.json).not.toHaveBeenCalled();
  expect(mocked.save).not.toHaveBeenCalled();
});

it("refuses plaintext upload on a fresh browser when the account requires encryption", async () => {
  mocked.configured.mockResolvedValue(false);
  mocked.session.mockReturnValue(null);
  const manager = new UploadManager();
  const requiredAccount = { ...account, clientEncryptionRequired: true };
  await expect(
    manager.enqueue(new File(["private bytes"], "private.txt"), requiredAccount, "root"),
  ).rejects.toThrow("暗号化が必須");
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.request).not.toHaveBeenCalled();
  expect(mocked.json).not.toHaveBeenCalled();
  expect(mocked.save).not.toHaveBeenCalled();
});

it("keeps an unlocked owner in read-only mode until an administrator key is pinned", async () => {
  mocked.configured.mockResolvedValue(true);
  mocked.session.mockReturnValue({
    owner: { publicKey: { fingerprint: "owner" } },
    adminRecipient: null,
  });
  const manager = new UploadManager();
  await expect(
    manager.enqueue(new File(["private bytes"], "private.txt"), account, "root"),
  ).rejects.toThrow("管理者の公開鍵を固定");
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.request).not.toHaveBeenCalled();
  expect(mocked.json).not.toHaveBeenCalled();
  expect(mocked.save).not.toHaveBeenCalled();
});

it("does not resume a persisted plaintext transfer after encryption becomes required", async () => {
  mocked.cleanup.mockResolvedValue(0);
  const file = new File(["private bytes"], "private.txt");
  mocked.stored.mockResolvedValue([
    {
      localId: "old-transfer",
      accountId: account.id,
      epoch: account.epoch,
      expiresAt: Date.now() + 60_000,
      name: file.name,
      sourceName: file.name,
      size: file.size,
      modified: file.lastModified,
      sample: "old-fingerprint",
      attempts: {},
    },
  ]);
  const manager = new UploadManager();
  await manager.load({ ...account, clientEncryptionRequired: true });
  const task = manager.snapshot()[0]!;
  await manager.resume(task, file);
  expect(task.phase).toBe("paused");
  expect(task.message).toContain("平文の送信は再開できません");
  expect(mocked.reopen).not.toHaveBeenCalled();
  expect(mocked.request).not.toHaveBeenCalled();
  expect(mocked.json).not.toHaveBeenCalled();
});

it("refuses replacement of an encrypted file even before this device enrolls", async () => {
  mocked.configured.mockResolvedValue(false);
  const manager = new UploadManager();
  const replacement = {
    kind: "file",
    name: `${"A".repeat(22)}.ncf`,
    encryption: { formatVersion: 2 },
    currentBlobId: "blob",
    revision: 1,
  } as FileNode;
  await expect(
    manager.enqueue(new File(["plaintext"], "plain.txt"), account, "root", replacement),
  ).rejects.toThrow("暗号化されたファイルの上書き");
  expect(mocked.save).not.toHaveBeenCalled();
});

it("persists only opaque ciphertext identity and resumes from the completed OPFS file", async () => {
  mocked.configured.mockResolvedValue(true);
  const publicKey = { fingerprint: "same", spki: "public" };
  const signing = {
    fingerprint: "signer",
    spki: "signing-spki",
    privateKey: { extractable: false, type: "private", algorithm: { name: "Ed25519" } },
  };
  mocked.session.mockReturnValue({
    owner: { publicKey, signing },
    ownerRegistered: true,
    adminRecipient: publicKey,
    adminSigner: { fingerprint: "admin-sign", spki: "admin-sign-spki" },
  });
  const cipherFile = new File(["ciphertext"], "opaque_crypto_id_1234.ncf", {
    type: "application/octet-stream",
    lastModified: 77,
  });
  mocked.create.mockResolvedValue({
    file: cipherFile,
    opaqueName: cipherFile.name,
    discard: vi.fn(),
    header: {},
    headerBytes: new Uint8Array([1]),
  });
  mocked.reopen.mockResolvedValue({ file: cipherFile, header: {} });
  mocked.fingerprint.mockResolvedValue("cipher_fingerprint");
  mocked.save.mockResolvedValue(undefined);
  const manager = new UploadManager();
  const source = new File(["private bytes"], "private.txt", { type: "text/plain" });
  await manager.enqueue(source, account, "root");
  const record = manager.snapshot()[0]!.record;
  expect(record.name).toBe(cipherFile.name);
  expect(record.sourceName).toBe(cipherFile.name);
  expect(record.encryptedSpool).toBe(cipherFile.name);
  expect(record.encryptionHeader).toBe("AQ");
  expect(mocked.create).toHaveBeenCalledWith(source, [publicKey], undefined, undefined, {
    ownerId: account.id,
    signer: signing,
  });
  expect(JSON.stringify(record)).not.toContain(source.name);
  expect(mocked.save).toHaveBeenCalledWith(record);
  await manager.resume(manager.snapshot()[0]!);
  expect(mocked.reopen).toHaveBeenCalledWith(cipherFile.name);
  expect(mocked.request).not.toHaveBeenCalled();
});
