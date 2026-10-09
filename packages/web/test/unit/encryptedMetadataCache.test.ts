import { beforeAll, expect, it } from "vitest";
import { encryptionHeaderHash } from "../../../shared/src/encryptionAttestation";
import type { Account, FileNode } from "../../src/lib/api";
import { createRecipientVault } from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
} from "../../src/lib/encryptedContainer";
import { openCachedMetadata } from "../../src/lib/encryptedMetadataCache";
import type { EncryptionSession } from "../../src/lib/encryptionSession";

const account = { id: "cache_owner", epoch: 2 } as Account;
let keys: EncryptionSession;
let bytes: Uint8Array;
let node: FileNode;
const writer: ContainerWriterFactory = async (name) => {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  return {
    async write(bytes) {
      parts.push(new Uint8Array(bytes));
    },
    async close() {
      return new File(parts, name);
    },
    async discard() {},
  };
};
beforeAll(async () => {
  const { unlocked: owner } = await createRecipientVault(account.id);
  keys = {
    owner,
    ownerRegistered: true,
    adminRecipient: owner.publicKey,
    adminSigner: owner.signing,
  };
  const made = await createEncryptedContainer(
    new File(["秘密の本文"], "すぐに表示する小説.txt", { type: "text/plain" }),
    [owner.publicKey],
    writer,
    undefined,
    { ownerId: account.id, signer: owner.signing },
  );
  bytes = made.headerBytes;
  node = {
    id: "file",
    currentBlobId: "blob",
    revision: 1,
    size: made.file.size,
    encryption: {
      formatVersion: 2,
      ownerId: account.id,
      cryptoId: made.header.envelope.cryptoId,
      headerSha256: await encryptionHeaderHash(new Uint8Array(bytes)),
      signerFingerprint: owner.signing.fingerprint,
      signerRsaFingerprint: owner.publicKey.fingerprint,
      requiredAdminFingerprint: owner.publicKey.fingerprint,
    },
  } as FileNode;
});
it("recovers the exact original metadata from an encrypted signed header without content requests", async () => {
  expect(new TextDecoder().decode(bytes)).not.toContain("すぐに表示する小説.txt");
  expect(await openCachedMetadata(account, node, keys, bytes)).toEqual({
    name: "すぐに表示する小説.txt",
    mime: "text/plain",
    size: new TextEncoder().encode("秘密の本文").length,
  });
});
it("does not reuse a header after the listing's immutable hash or size changes", async () => {
  await expect(
    openCachedMetadata(account, { ...node, size: node.size! + 1 }, keys, bytes),
  ).rejects.toThrow();
  await expect(
    openCachedMetadata(
      account,
      { ...node, encryption: { ...node.encryption!, headerSha256: "changed" } },
      keys,
      bytes,
    ),
  ).rejects.toThrow();
});
it("requires the current account and registered owner and administrator keys", async () => {
  expect(await openCachedMetadata({ ...account, id: "another" }, node, keys, bytes)).toBeNull();
  expect(
    await openCachedMetadata(account, node, { ...keys, ownerRegistered: false }, bytes),
  ).toBeNull();
  expect(
    await openCachedMetadata(account, node, { ...keys, adminRecipient: null }, bytes),
  ).toBeNull();
  expect(
    await openCachedMetadata(
      account,
      { ...node, encryption: { ...node.encryption!, signerFingerprint: "changed" } },
      keys,
      bytes,
    ),
  ).toBeNull();
});
