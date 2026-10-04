import { primary } from "../db/primary";

export interface BlobEncryptionRow {
  blobId: string;
  ownerId: string;
  headerSha256: string;
  signerRsaFingerprint: string;
  signerSigningFingerprint: string;
  requiredAdminFingerprint: string;
  cryptoId: string;
  formatVersion: 1 | 2;
  ownerSignature: string | null;
  attestedNodeId: string | null;
  attestedRevision: number | null;
  adminReceiptState: "pending" | "verified";
  adminReceiptSignature: string | null;
  adminAccountId: string | null;
  adminVerifiedAt: number | null;
  verifiedAt: number;
}

export const ENCRYPTION_COLUMNS = `be.blob_id AS encBlobId,be.owner_id AS encOwnerId,
  be.header_sha256 AS encHeaderSha256,be.signer_rsa_fingerprint AS encSignerRsaFingerprint,
  be.signer_signing_fingerprint AS encSignerSigningFingerprint,
  be.required_admin_fingerprint AS encRequiredAdminFingerprint,
  be.crypto_id AS encCryptoId,be.format_version AS encFormatVersion,
  be.owner_signature AS encOwnerSignature,be.attested_node_id AS encAttestedNodeId,
  be.attested_revision AS encAttestedRevision,be.admin_receipt_state AS encAdminReceiptState,
  be.admin_receipt_signature AS encAdminReceiptSignature,be.admin_account_id AS encAdminAccountId,
  be.admin_verified_at AS encAdminVerifiedAt`;

export interface EncryptionProjection {
  encBlobId: string | null;
  encOwnerId: string | null;
  encHeaderSha256: string | null;
  encSignerRsaFingerprint: string | null;
  encSignerSigningFingerprint: string | null;
  encRequiredAdminFingerprint: string | null;
  encCryptoId: string | null;
  encFormatVersion: 1 | 2 | null;
  encOwnerSignature: string | null;
  encAttestedNodeId: string | null;
  encAttestedRevision: number | null;
  encAdminReceiptState: "pending" | "verified" | null;
  encAdminReceiptSignature: string | null;
  encAdminAccountId: string | null;
  encAdminVerifiedAt: number | null;
}

/** A marker is proof about a current R2 blob, never inferred from filename or MIME. */
export function encryptionDto(row: EncryptionProjection | null | undefined) {
  if (!row?.encBlobId) return null;
  return {
    formatVersion: row.encFormatVersion,
    headerSha256: row.encHeaderSha256,
    ownerId: row.encOwnerId,
    cryptoId: row.encCryptoId,
    signerFingerprint: row.encSignerSigningFingerprint,
    signerRsaFingerprint: row.encSignerRsaFingerprint,
    requiredAdminFingerprint: row.encRequiredAdminFingerprint,
    adminReceiptState: row.encAdminReceiptState,
    legacyAttestation: row.encFormatVersion === 1,
    ownerSignature: row.encOwnerSignature,
    attestedNodeId: row.encAttestedNodeId,
    attestedRevision: row.encAttestedRevision,
    adminReceiptSignature: row.encAdminReceiptSignature,
    adminAccountId: row.encAdminAccountId,
    adminVerifiedAt: row.encAdminVerifiedAt,
  };
}

export function blobEncryptionDto(row: BlobEncryptionRow | null | undefined) {
  if (!row) return null;
  return {
    formatVersion: row.formatVersion,
    headerSha256: row.headerSha256,
    ownerId: row.ownerId,
    cryptoId: row.cryptoId,
    signerFingerprint: row.signerSigningFingerprint,
    signerRsaFingerprint: row.signerRsaFingerprint,
    requiredAdminFingerprint: row.requiredAdminFingerprint,
    adminReceiptState: row.adminReceiptState,
    legacyAttestation: row.formatVersion === 1,
    ownerSignature: row.ownerSignature,
    attestedNodeId: row.attestedNodeId,
    attestedRevision: row.attestedRevision,
    adminReceiptSignature: row.adminReceiptSignature,
    adminAccountId: row.adminAccountId,
    adminVerifiedAt: row.adminVerifiedAt,
  };
}

export async function readBlobEncryption(db: D1Database, blobId: string) {
  return primary(db)
    .prepare(`SELECT blob_id AS blobId,owner_id AS ownerId,header_sha256 AS headerSha256,
      signer_rsa_fingerprint AS signerRsaFingerprint,
      signer_signing_fingerprint AS signerSigningFingerprint,
      required_admin_fingerprint AS requiredAdminFingerprint,crypto_id AS cryptoId,
      format_version AS formatVersion,owner_signature AS ownerSignature,
      attested_node_id AS attestedNodeId,attested_revision AS attestedRevision,
      admin_receipt_state AS adminReceiptState,admin_receipt_signature AS adminReceiptSignature,
      admin_account_id AS adminAccountId,admin_verified_at AS adminVerifiedAt,
      verified_at AS verifiedAt FROM blob_encryption WHERE blob_id=?`)
    .bind(blobId)
    .first<BlobEncryptionRow>();
}
