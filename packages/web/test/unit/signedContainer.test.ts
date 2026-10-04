import { beforeAll, describe, expect, it } from "vitest";
import {
  encryptionHeaderHash,
  legacyAdoptionPayload,
} from "../../../shared/src/encryptionAttestation";
import {
  canonicalSignedHeader,
  encodeSignedBase64,
  parseAndVerifySignedContainerHeader,
  serializeSignedContainerHeader,
  signedHeaderPayload,
} from "../../../shared/src/signedContainer";
import {
  createRecipientVault,
  unlockRecipientVault,
  unwrapFileCipher,
} from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
  openAttestedLegacyContainerHeader,
  openAuthenticatedContainerHeader,
  openContainerHeader,
  parseContainerHeader,
} from "../../src/lib/encryptedContainer";

const writer: ContainerWriterFactory = async (name) => {
  const parts: Uint8Array[] = [];
  return {
    async write(bytes) {
      parts.push(new Uint8Array(bytes));
    },
    async close() {
      return new File(
        parts.map((part) => new Uint8Array(part)),
        name,
      );
    },
    async discard() {
      parts.length = 0;
    },
  };
};

describe("signed v2 encrypted container", () => {
  let owner: Awaited<ReturnType<typeof createRecipientVault>>;
  let admin: Awaited<ReturnType<typeof createRecipientVault>>;
  beforeAll(async () => {
    owner = await createRecipientVault("owner_user");
    admin = await createRecipientVault("admin_user");
  }, 30_000);

  it("derives the same nonextractable Ed25519 identity from existing recovery JSON", async () => {
    const recovered = await unlockRecipientVault(owner.vault, owner.recoveryKey, "owner_user");
    expect(recovered.signing.spki).toBe(owner.unlocked.signing.spki);
    expect(recovered.signing.fingerprint).toBe(owner.unlocked.signing.fingerprint);
    expect(recovered.signing.privateKey.extractable).toBe(false);
    expect(recovered.privateKey.extractable).toBe(false);
    const probe = new TextEncoder().encode("identity-proof");
    const signature = await crypto.subtle.sign("Ed25519", recovered.signing.privateKey, probe);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(recovered.signing.spki.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0),
      ),
      "Ed25519",
      false,
      ["verify"],
    );
    expect(await crypto.subtle.verify("Ed25519", publicKey, signature, probe)).toBe(true);
  }, 30_000);

  it("binds owner, complete recipient list, encrypted metadata and total bytes to trusted signer", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "private.png", { type: "image/png" });
    const made = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey, admin.unlocked.publicKey],
      writer,
      undefined,
      { ownerId: "owner_user", signer: owner.unlocked.signing },
    );
    const headerBytes = new Uint8Array(
      await made.file.slice(0, made.header.headerEnd).arrayBuffer(),
    );
    const options = {
      expectedOwnerId: "owner_user",
      expectedSize: made.file.size,
      ownerSigningSpki: owner.unlocked.signing.spki,
      requiredOwnerFingerprint: owner.unlocked.publicKey.fingerprint,
      requiredAdminFingerprint: admin.unlocked.publicKey.fingerprint,
    };
    const proof = await parseAndVerifySignedContainerHeader(headerBytes, options);
    expect(proof.headerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.recipientFingerprints).toContain(admin.unlocked.publicKey.fingerprint);
    const opened = await openAuthenticatedContainerHeader(made.header, admin.unlocked, {
      ...options,
      expectedHeaderSha256: proof.headerSha256,
    });
    expect(opened.metadata.name).toBe("private.png");
    await expect(
      parseAndVerifySignedContainerHeader(headerBytes, { ...options, expectedOwnerId: "wrong" }),
    ).rejects.toThrow();
    await expect(
      parseAndVerifySignedContainerHeader(headerBytes, {
        ...options,
        expectedSize: made.file.size + 1,
      }),
    ).rejects.toThrow();
    await expect(
      parseAndVerifySignedContainerHeader(headerBytes, {
        ...options,
        expectedHeaderSha256: "0".repeat(64),
      }),
    ).rejects.toThrow();
    const forged = await createRecipientVault("attacker");
    await expect(
      parseAndVerifySignedContainerHeader(headerBytes, {
        ...options,
        ownerSigningSpki: forged.unlocked.signing.spki,
      }),
    ).rejects.toThrow();
    await expect(
      openContainerHeader(made.header, admin.unlocked, { legacyUnsigned: true }),
    ).rejects.toThrow();
    const tampered = {
      ...made.header.signed!,
      envelope: {
        ...made.header.signed!.envelope,
        recipients: made.header.signed!.envelope.recipients.map((entry) => ({
          ...entry,
          wrappedKey:
            entry.fingerprint === admin.unlocked.publicKey.fingerprint
              ? encodeSignedBase64(new Uint8Array(384))
              : entry.wrappedKey,
        })),
      },
    };
    await expect(
      parseAndVerifySignedContainerHeader(serializeSignedContainerHeader(tampered), options),
    ).rejects.toThrow();
    // A malicious owner can sign unusable wraps. Server signature validation must be paired with an admin receipt.
    const signedBad = canonicalSignedHeader({
      ...tampered,
      signature: encodeSignedBase64(new Uint8Array(64)),
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        owner.unlocked.signing.privateKey,
        signedHeaderPayload(signedBad),
      ),
    );
    const badBytes = serializeSignedContainerHeader({
      ...signedBad,
      signature: encodeSignedBase64(signature),
    });
    await parseAndVerifySignedContainerHeader(badBytes, {
      ...options,
      expectedSize: badBytes.length + signedBad.envelope.cipherSize,
    });
    await expect(
      unwrapFileCipher(parseContainerHeader(badBytes).envelope, admin.unlocked),
    ).rejects.toThrow();
  }, 30_000);

  it("requires explicit legacy opening and rejects v1 in authenticated flow", async () => {
    const source = new File([new Uint8Array([7])], "old.bin");
    const made = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey],
      writer,
      undefined,
      { legacyUnsigned: true },
    );
    await expect(
      openAuthenticatedContainerHeader(made.header, owner.unlocked, {
        expectedOwnerId: "owner_user",
        expectedSize: made.file.size,
        ownerSigningSpki: owner.unlocked.signing.spki,
        requiredOwnerFingerprint: owner.unlocked.publicKey.fingerprint,
        requiredAdminFingerprint: owner.unlocked.publicKey.fingerprint,
      }),
    ).rejects.toThrow();
    const opened = await openContainerHeader(made.header, owner.unlocked, { legacyUnsigned: true });
    expect(opened.metadata.name).toBe("old.bin");
    const bytes = new Uint8Array(await made.file.slice(0, made.header.headerEnd).arrayBuffer());
    const attestation = {
      ownerId: "owner_user",
      nodeId: "node_1",
      blobId: "blob_1",
      revision: 7,
      headerSha256: await encryptionHeaderHash(bytes),
      cryptoId: made.header.envelope.cryptoId,
      requiredAdminFingerprint: owner.unlocked.publicKey.fingerprint,
    };
    const ownerSignature = encodeSignedBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          owner.unlocked.signing.privateKey,
          legacyAdoptionPayload(attestation),
        ),
      ),
    );
    const options = {
      attestation,
      ownerSignature,
      ownerSigningSpki: owner.unlocked.signing.spki,
      expectedOwnerId: "owner_user",
      expectedNodeId: "node_1",
      expectedBlobId: "blob_1",
      expectedSize: made.file.size,
      expectedOwnerFingerprint: owner.unlocked.publicKey.fingerprint,
      expectedAdminFingerprint: owner.unlocked.publicKey.fingerprint,
    };
    expect(
      (await openAttestedLegacyContainerHeader(made.header, owner.unlocked, options)).metadata.name,
    ).toBe("old.bin");
    await expect(
      openAttestedLegacyContainerHeader(made.header, owner.unlocked, {
        ...options,
        expectedNodeId: "copied_node",
      }),
    ).rejects.toThrow();
    await expect(
      openAttestedLegacyContainerHeader(made.header, owner.unlocked, {
        ...options,
        expectedBlobId: "other_blob",
      }),
    ).rejects.toThrow();
    await expect(
      openAttestedLegacyContainerHeader(made.header, owner.unlocked, {
        ...options,
        ownerSigningSpki: admin.unlocked.signing.spki,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
