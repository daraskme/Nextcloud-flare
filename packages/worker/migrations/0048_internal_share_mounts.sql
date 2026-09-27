-- New internal shares keep the name assigned at creation, even if their root is renamed.
-- Legacy grants remain valid; a missing historical mount name is not invented here.
ALTER TABLE shares ADD COLUMN mount_name TEXT CHECK(mount_name IS NULL OR length(CAST(mount_name AS BLOB)) BETWEEN 1 AND 255);
ALTER TABLE shares ADD COLUMN mount_name_ci TEXT CHECK(mount_name_ci IS NULL OR length(CAST(mount_name_ci AS BLOB)) BETWEEN 1 AND 1024);
CREATE UNIQUE INDEX shares_mount_name ON shares(mount_name_ci) WHERE mount_name_ci IS NOT NULL;
CREATE INDEX shares_owner_created ON shares(owner_id,created_at DESC,id DESC);
CREATE INDEX users_email_lookup ON users(lower(email));
CREATE TRIGGER shares_mount_insert BEFORE INSERT ON shares
WHEN (NEW.mount_name IS NULL)<>(NEW.mount_name_ci IS NULL)
 OR (NEW.mount_name IS NOT NULL AND NEW.kind<>'internal')
BEGIN SELECT RAISE(ABORT,'invalid_share_mount'); END;
CREATE TRIGGER shares_mount_update BEFORE UPDATE ON shares
WHEN NEW.mount_name IS NOT OLD.mount_name OR NEW.mount_name_ci IS NOT OLD.mount_name_ci
 OR (NEW.mount_name IS NOT NULL AND NEW.kind<>'internal')
BEGIN SELECT RAISE(ABORT,'immutable_share_mount'); END;
