ALTER TABLE shares ADD COLUMN mount_name TEXT
  CHECK(mount_name IS NULL OR length(CAST(mount_name AS BLOB)) BETWEEN 1 AND 255);
ALTER TABLE shares ADD COLUMN mount_name_ci TEXT
  CHECK(mount_name_ci IS NULL OR length(CAST(mount_name_ci AS BLOB)) BETWEEN 1 AND 1024);

CREATE UNIQUE INDEX shares_internal_mount_name
ON shares(mount_name_ci)
WHERE kind='internal' AND mount_name_ci IS NOT NULL;

CREATE INDEX shares_recipient_active
ON share_grants(user_id,disabled_at,share_id,version);
