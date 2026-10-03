import { decodeSignedBase64 } from "./signedContainer";

const encoder = {
  encode: (value: string): Uint8Array<ArrayBuffer> =>
    new Uint8Array(new TextEncoder().encode(value)),
};
const id = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_encryption_attestation");
  return value;
};
const hash = (value: string) => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_encryption_attestation");
  return value;
};
const fingerprint = (value: string) => {
  decodeSignedBase64(value, 32, 32);
  return value;
};
const cryptoId = (value: string) => {
  decodeSignedBase64(value, 16, 16);
  return value;
};

export interface LegacyAdoption {
  readonly ownerId: string;
  readonly nodeId: string;
  readonly blobId: string;
  readonly revision: number;
  readonly headerSha256: string;
  readonly cryptoId: string;
  readonly requiredAdminFingerprint: string;
}

/** Approval of one existing immutable blob, never a claim about its historical sender. */
export function legacyAdoptionPayload(value: LegacyAdoption): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new Error("invalid_encryption_attestation");
  return encoder.encode(
    [
      "ncf-container-adopt-v1",
      id(value.ownerId),
      id(value.nodeId),
      id(value.blobId),
      String(value.revision),
      hash(value.headerSha256),
      cryptoId(value.cryptoId),
      fingerprint(value.requiredAdminFingerprint),
    ].join("\0"),
  );
}

export interface AdminReceipt {
  readonly ownerId: string;
  readonly blobId: string;
  readonly headerSha256: string;
  readonly cryptoId: string;
  readonly adminAccountId: string;
  readonly adminFingerprint: string;
}

/** Administrator attestation that this recipient wrap was successfully opened locally. */
export function adminReceiptPayload(value: AdminReceipt): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    [
      "ncf-admin-decrypt-v1",
      id(value.ownerId),
      id(value.blobId),
      hash(value.headerSha256),
      cryptoId(value.cryptoId),
      id(value.adminAccountId),
      fingerprint(value.adminFingerprint),
    ].join("\0"),
  );
}

export async function verifyEncryptionAttestation(
  spki: string,
  signature: string,
  payload: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      decodeSignedBase64(spki, 40, 80),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeSignedBase64(signature, 64, 64),
      payload,
    );
  } catch {
    return false;
  }
}

export async function encryptionHeaderHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
