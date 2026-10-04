import {
  decodeSignedBase64,
  parseAndVerifySignedContainerHeader,
  parseSignedContainerHeader,
} from "@next-cloud-flare/shared/signedContainer";

interface RegisteredKey {
  accountId: string;
  rsaFingerprint: string;
  signingFingerprint: string;
  signingSpki: string;
}
export interface VerifiedUploadEncryption {
  headerSha256: string;
  cryptoId: string;
  signerFingerprint: string;
  signerRsaFingerprint: string;
  requiredAdminFingerprint: string;
}

function deny(): never {
  throw new Error("invalid_upload_encryption");
}

async function keys(db: D1Database, ownerId: string) {
  const result = await db
    .prepare(`SELECT k.account_id AS accountId,k.rsa_fingerprint AS rsaFingerprint,
      k.signing_fingerprint AS signingFingerprint,k.signing_spki AS signingSpki,u.role AS role
    FROM encryption_keys k JOIN users u ON u.id=k.account_id
    WHERE k.revoked_at IS NULL AND u.disabled_at IS NULL AND (k.account_id=? OR u.role='app_admin')`)
    .bind(ownerId)
    .all<RegisteredKey & { role: string }>();
  const rows = result.results;
  const owner = rows.find((row) => row.accountId === ownerId);
  const admins = rows.filter((row) => row.role === "app_admin");
  if (!owner || admins.length < 1) deny();
  return { owner, admins };
}

export async function verifyDeclaredEncryptionHeader(
  db: D1Database,
  ownerId: string,
  size: number,
  encoded: string,
): Promise<VerifiedUploadEncryption> {
  const header = decodeSignedBase64(encoded, 13, 12 + 16 * 1024);
  return verifyEncryptionHeader(db, ownerId, size, header);
}

async function verifyEncryptionHeader(
  db: D1Database,
  ownerId: string,
  size: number,
  header: Uint8Array,
  expectedHash?: string,
): Promise<VerifiedUploadEncryption> {
  const { owner, admins } = await keys(db, ownerId);
  const parsed = parseSignedContainerHeader(header);
  const wraps = new Set(parsed.envelope.recipients.map((recipient) => recipient.fingerprint));
  const selfAdmin = admins.find((admin) => admin.accountId === ownerId);
  const matches = admins.filter((admin) => wraps.has(admin.rsaFingerprint));
  const admin = selfAdmin ?? (matches.length === 1 ? matches[0] : null);
  if (!admin || !wraps.has(admin.rsaFingerprint)) deny();
  const verified = await parseAndVerifySignedContainerHeader(header, {
    expectedOwnerId: ownerId,
    expectedSize: size,
    ownerSigningSpki: owner.signingSpki,
    requiredOwnerFingerprint: owner.rsaFingerprint,
    requiredAdminFingerprint: admin.rsaFingerprint,
    ...(expectedHash ? { expectedHeaderSha256: expectedHash } : {}),
  });
  if (verified.signerFingerprint !== owner.signingFingerprint) deny();
  return {
    headerSha256: verified.headerSha256,
    cryptoId: verified.cryptoId,
    signerFingerprint: verified.signerFingerprint,
    signerRsaFingerprint: owner.rsaFingerprint,
    requiredAdminFingerprint: admin.rsaFingerprint,
  };
}

export async function verifyStoredEncryptionHeader(
  db: D1Database,
  bucket: R2Bucket,
  key: string,
  ownerId: string,
  size: number,
  expectedHash: string,
  expectedEtag: string,
): Promise<VerifiedUploadEncryption> {
  if (size < 13 || !/^[0-9a-f]{64}$/.test(expectedHash)) deny();
  const prefix = await bucket.get(key, {
    range: { offset: 0, length: 12 },
    onlyIf: { etagMatches: expectedEtag },
  });
  if (!prefix || !("body" in prefix) || prefix.size !== size || prefix.etag !== expectedEtag)
    deny();
  const first = new Uint8Array(await prefix.arrayBuffer());
  if (first.length !== 12 || [78, 67, 70, 69, 78, 67, 50, 0].some((byte, i) => first[i] !== byte))
    deny();
  const length = new DataView(first.buffer).getUint32(8, false);
  if (length < 1 || length > 16 * 1024 || 12 + length > size) deny();
  const object = await bucket.get(key, {
    range: { offset: 0, length: 12 + length },
    onlyIf: { etagMatches: expectedEtag },
  });
  if (!object || !("body" in object) || object.size !== size || object.etag !== expectedEtag)
    deny();
  const header = new Uint8Array(await object.arrayBuffer());
  if (header.length !== 12 + length) deny();
  return verifyEncryptionHeader(db, ownerId, size, header, expectedHash);
}

export function requireEncryptedUpload(enabled: string | undefined, headerHash: string | null) {
  if (enabled === "true" && !headerHash) throw new Error("encryption_required");
}
