ALTER TABLE uploads ADD COLUMN part_bytes INTEGER CHECK(part_bytes IS NULL OR part_bytes BETWEEN 8388608 AND 94371840);
ALTER TABLE uploads ADD COLUMN part_count INTEGER CHECK(part_count IS NULL OR part_count BETWEEN 1 AND 10000);
ALTER TABLE uploads ADD COLUMN multipart_ledger_id TEXT;
ALTER TABLE uploads ADD COLUMN multipart_revision INTEGER NOT NULL DEFAULT 0 CHECK(multipart_revision>=0);

CREATE TRIGGER uploads_multipart_geometry_insert BEFORE INSERT ON uploads
WHEN (NEW.part_bytes IS NULL)<>(NEW.part_count IS NULL)
 OR (NEW.part_bytes IS NOT NULL AND (NEW.mode<>'multipart' OR NEW.part_count<>(NEW.declared_size+NEW.part_bytes-1)/NEW.part_bytes))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_geometry'); END;
CREATE TRIGGER uploads_multipart_identity BEFORE UPDATE OF part_bytes,part_count,r2_upload_id,multipart_ledger_id,write_attempt_id,write_lease_expires_at ON uploads
WHEN NEW.part_bytes IS NOT OLD.part_bytes OR NEW.part_count IS NOT OLD.part_count
 OR (OLD.mode='multipart' AND (
   (OLD.r2_upload_id IS NOT NULL AND NEW.r2_upload_id IS NOT OLD.r2_upload_id)
   OR (OLD.multipart_ledger_id IS NOT NULL AND NEW.multipart_ledger_id IS NOT OLD.multipart_ledger_id)
   OR (OLD.write_attempt_id IS NOT NULL AND (NEW.write_attempt_id IS NOT OLD.write_attempt_id OR NEW.write_lease_expires_at IS NOT OLD.write_lease_expires_at))))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_identity'); END;
CREATE TRIGGER uploads_multipart_revision BEFORE UPDATE OF multipart_revision ON uploads
WHEN NEW.multipart_revision<OLD.multipart_revision
BEGIN SELECT RAISE(ABORT,'multipart_revision_regression'); END;
