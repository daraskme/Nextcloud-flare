-- Server-pinned client encryption identities. A key belongs to the current Access user;
-- administrator authority is always read from users.role, never copied from a request.
ALTER TABLE uploads ADD COLUMN encryption_header_sha256 TEXT
  CHECK(encryption_header_sha256 IS NULL OR length(encryption_header_sha256)=64);

CREATE TABLE encryption_keys(
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  rsa_fingerprint TEXT NOT NULL CHECK(length(rsa_fingerprint)=43),
  rsa_spki TEXT NOT NULL CHECK(length(rsa_spki) BETWEEN 400 AND 1100),
  signing_fingerprint TEXT NOT NULL CHECK(length(signing_fingerprint)=43),
  signing_spki TEXT NOT NULL CHECK(length(signing_spki) BETWEEN 40 AND 100),
  registered_at INTEGER NOT NULL CHECK(registered_at>=0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=registered_at)
) STRICT;
CREATE UNIQUE INDEX encryption_keys_rsa_fingerprint ON encryption_keys(rsa_fingerprint);
CREATE UNIQUE INDEX encryption_keys_signing_fingerprint ON encryption_keys(signing_fingerprint);

-- Single-use proof of RSA-OAEP decryption and Ed25519 signing possession.
CREATE TABLE encryption_key_challenges(
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  rsa_fingerprint TEXT NOT NULL CHECK(length(rsa_fingerprint)=43),
  rsa_spki TEXT NOT NULL,
  signing_fingerprint TEXT NOT NULL CHECK(length(signing_fingerprint)=43),
  signing_spki TEXT NOT NULL CHECK(length(signing_spki) BETWEEN 40 AND 100),
  secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at>=created_at)
) STRICT;
CREATE INDEX encryption_key_challenges_owner_expiry ON encryption_key_challenges(account_id,expires_at);
CREATE INDEX encryption_key_challenges_credential ON encryption_key_challenges(credential_id);

-- This marker is written only after the R2 object header is inspected and its signature verified.
-- It is separate from a filename or declared Content-Type, and follows blob GC automatically.
CREATE TABLE blob_encryption(
  blob_id TEXT NOT NULL PRIMARY KEY REFERENCES blobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  header_sha256 TEXT NOT NULL CHECK(length(header_sha256)=64),
  signer_rsa_fingerprint TEXT NOT NULL CHECK(length(signer_rsa_fingerprint)=43),
  signer_signing_fingerprint TEXT NOT NULL CHECK(length(signer_signing_fingerprint)=43),
  required_admin_fingerprint TEXT NOT NULL CHECK(length(required_admin_fingerprint)=43),
  crypto_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK(format_version IN (1,2)),
  owner_signature TEXT CHECK(owner_signature IS NULL OR length(owner_signature)=86),
  attested_node_id TEXT,
  attested_revision INTEGER CHECK(attested_revision IS NULL OR attested_revision>=1),
  admin_receipt_state TEXT NOT NULL CHECK(admin_receipt_state IN ('pending','verified')),
  admin_receipt_signature TEXT CHECK(admin_receipt_signature IS NULL OR length(admin_receipt_signature)=86),
  admin_account_id TEXT REFERENCES users(id),
  admin_verified_at INTEGER CHECK(admin_verified_at IS NULL OR admin_verified_at>=0),
  verified_at INTEGER NOT NULL CHECK(verified_at>=0),
  CHECK((format_version=1 AND owner_signature IS NOT NULL AND attested_node_id IS NOT NULL AND attested_revision IS NOT NULL)
    OR (format_version=2 AND owner_signature IS NULL AND attested_node_id IS NULL AND attested_revision IS NULL)),
  CHECK((admin_receipt_state='verified')=(admin_receipt_signature IS NOT NULL AND admin_account_id IS NOT NULL AND admin_verified_at IS NOT NULL))
) STRICT;
CREATE INDEX blob_encryption_owner ON blob_encryption(owner_id,blob_id);
CREATE INDEX blob_encryption_admin_account ON blob_encryption(admin_account_id);

INSERT INTO operation_kinds(name) VALUES
  ('encryption.key.challenge'),('encryption.key.register'),
  ('encryption.key.read'),('encryption.admin_key.read'),
  ('encryption.file.adopt'),('encryption.admin.receipt');

CREATE TRIGGER backup_freeze_encryption_keys_insert BEFORE INSERT ON encryption_keys
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_encryption_keys_update BEFORE UPDATE ON encryption_keys
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_encryption_keys_delete BEFORE DELETE ON encryption_keys
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_encryption_key_challenges_insert BEFORE INSERT ON encryption_key_challenges
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_encryption_key_challenges_update BEFORE UPDATE ON encryption_key_challenges
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_encryption_key_challenges_delete BEFORE DELETE ON encryption_key_challenges
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_blob_encryption_insert BEFORE INSERT ON blob_encryption
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_blob_encryption_update BEFORE UPDATE ON blob_encryption
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_blob_encryption_delete BEFORE DELETE ON blob_encryption
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
