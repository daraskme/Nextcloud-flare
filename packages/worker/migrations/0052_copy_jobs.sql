-- Async acceptance is committed independently of eventual namespace publication.
-- The old catalogue had no copy executor. Unknown legacy jobs need explicit reconciliation.
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM bulk_jobs WHERE kind='node.copy');
INSERT INTO operation_kinds VALUES('copy.enqueue');
DROP TRIGGER operations_destination_insert;
CREATE TRIGGER operations_destination_insert BEFORE INSERT ON operations
WHEN (NEW.destination_share_id IS NULL)<>(NEW.destination_share_version IS NULL)
  OR (NEW.destination_space_id IS NULL AND NEW.destination_share_id IS NOT NULL)
  OR (NEW.kind='copy.enqueue' AND (NEW.destination_space_id IS NULL OR NEW.principal_kind<>'user' OR NEW.destination_space_id=NEW.space_id))
  OR (NEW.destination_space_id IS NOT NULL AND (
    NEW.kind NOT IN ('node.copy','node.move','dav.copy','dav.move','copy.enqueue')
    OR NEW.principal_kind NOT IN ('user','app_password')
    OR (NEW.kind<>'copy.enqueue' AND NEW.destination_space_id<>NEW.space_id)
    OR NOT EXISTS(SELECT 1 FROM spaces sp WHERE sp.id=NEW.destination_space_id AND (
      (NEW.destination_share_id IS NULL AND sp.owner_id=NEW.principal_id)
      OR EXISTS(SELECT 1 FROM shares sh WHERE sh.id=NEW.destination_share_id AND sh.kind='internal'
        AND sh.owner_id=sp.owner_id AND sh.version>=NEW.destination_share_version)))))
BEGIN SELECT RAISE(ABORT,'invalid_transfer_destination'); END;

CREATE TABLE copy_job_manifests(
  job_id TEXT NOT NULL PRIMARY KEY REFERENCES bulk_jobs(id),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 8388608),
  chunks INTEGER NOT NULL CHECK(chunks BETWEEN 1 AND 128 AND chunks=(bytes+65535)/65536),
  expires_at INTEGER NOT NULL CHECK(expires_at>0)
) STRICT;
CREATE TABLE copy_job_chunks(
  job_id TEXT NOT NULL REFERENCES copy_job_manifests(job_id),
  part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 127),
  data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 65536),
  PRIMARY KEY(job_id,part)
) STRICT;
CREATE TABLE copy_job_blobs(
  job_id TEXT NOT NULL REFERENCES copy_job_manifests(job_id),
  source_blob_id TEXT NOT NULL REFERENCES blobs(id),
  destination_blob_id TEXT NOT NULL UNIQUE,
  pin_id TEXT NOT NULL UNIQUE REFERENCES blob_pins(pin_id),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  PRIMARY KEY(job_id,source_blob_id)
) STRICT;
CREATE INDEX copy_job_blobs_source ON copy_job_blobs(source_blob_id);
CREATE TRIGGER copy_job_identity BEFORE UPDATE ON bulk_jobs WHEN OLD.kind='node.copy' AND (
  NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.credential_id IS NOT OLD.credential_id
  OR NEW.op_id<>OLD.op_id OR NEW.kind<>OLD.kind OR NEW.epoch<>OLD.epoch
  OR NEW.manifest_ref IS NOT OLD.manifest_ref OR NEW.grant_snapshot<>OLD.grant_snapshot
  OR NEW.node_count<>OLD.node_count OR NEW.blob_count<>OLD.blob_count
  OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at)
BEGIN SELECT RAISE(ABORT,'immutable_copy_job'); END;
CREATE TRIGGER copy_job_insert BEFORE INSERT ON bulk_jobs WHEN NEW.kind='node.copy' AND (
  NEW.state<>'pending' OR NEW.checkpoint IS NOT NULL OR NEW.r2_calls<>0 OR NEW.invocation_count<>0
  OR length(CAST(NEW.grant_snapshot AS BLOB))>8192
  OR NOT EXISTS(SELECT 1 FROM operations o JOIN spaces s ON s.id=o.destination_space_id
    WHERE o.op_id=NEW.op_id AND o.kind='copy.enqueue' AND o.principal_kind='user'
      AND o.state='claimed' AND o.epoch=NEW.epoch AND o.credential_id=NEW.credential_id
      AND s.owner_id=NEW.owner_id AND NEW.id='copy_'||substr(o.op_id,4)
      AND NEW.manifest_ref='d1:copy/'||NEW.id))
BEGIN SELECT RAISE(ABORT,'invalid_copy_job'); END;
CREATE TRIGGER copy_job_manifest_insert BEFORE INSERT ON copy_job_manifests
WHEN NOT EXISTS(SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
  WHERE j.id=NEW.job_id AND j.kind='node.copy' AND j.state='pending' AND o.state='claimed'
    AND NEW.expires_at>j.created_at AND NEW.expires_at<=j.created_at+86400000)
BEGIN SELECT RAISE(ABORT,'invalid_copy_manifest'); END;
CREATE TRIGGER copy_job_manifest_identity BEFORE UPDATE ON copy_job_manifests
BEGIN SELECT RAISE(ABORT,'immutable_copy_manifest'); END;
CREATE TRIGGER copy_job_chunk_insert BEFORE INSERT ON copy_job_chunks
WHEN NOT EXISTS(SELECT 1 FROM copy_job_manifests m JOIN bulk_jobs j ON j.id=m.job_id
  JOIN operations o ON o.op_id=j.op_id WHERE m.job_id=NEW.job_id AND o.state='claimed'
    AND NEW.part<m.chunks AND length(NEW.data)=MIN(65536,m.bytes-NEW.part*65536))
BEGIN SELECT RAISE(ABORT,'invalid_copy_chunk'); END;
CREATE TRIGGER copy_job_chunk_identity BEFORE UPDATE ON copy_job_chunks
BEGIN SELECT RAISE(ABORT,'immutable_copy_chunk'); END;
CREATE TRIGGER copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN NOT EXISTS(SELECT 1 FROM copy_job_manifests m JOIN bulk_jobs j ON j.id=m.job_id
  JOIN operations o ON o.op_id=j.op_id JOIN spaces sp ON sp.id=o.space_id
  JOIN blobs b ON b.id=NEW.source_blob_id JOIN blob_pins p ON p.pin_id=NEW.pin_id
  JOIN reservations r ON r.id=NEW.reservation_id
  WHERE m.job_id=NEW.job_id AND j.state='pending' AND o.state='claimed'
    AND b.owner_id=sp.owner_id AND b.owner_id<>j.owner_id AND b.state IN ('committed','gc_candidate')
    AND p.blob_id=b.id AND p.purpose='copy' AND p.expires_at=m.expires_at
    AND r.owner_id=j.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.epoch=j.epoch
    AND r.expires_at=m.expires_at AND r.share_id IS NULL AND r.op_id IS NULL
    AND length(NEW.destination_blob_id)=76 AND substr(NEW.destination_blob_id,1,71)=NEW.job_id||'_b'
    AND substr(NEW.destination_blob_id,72) NOT GLOB '*[^0-9]*')
BEGIN SELECT RAISE(ABORT,'invalid_copy_hold'); END;
CREATE TRIGGER copy_job_blobs_identity BEFORE UPDATE ON copy_job_blobs
BEGIN SELECT RAISE(ABORT,'immutable_copy_hold'); END;
CREATE TRIGGER copy_job_reservation_hold BEFORE UPDATE ON reservations
WHEN EXISTS(SELECT 1 FROM copy_job_blobs cb WHERE cb.reservation_id=OLD.id)
  AND (NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.bytes<>OLD.bytes OR NEW.state<>OLD.state
    OR NEW.epoch<>OLD.epoch OR NEW.expires_at<>OLD.expires_at OR NEW.share_id IS NOT OLD.share_id OR NEW.op_id IS NOT OLD.op_id)
BEGIN SELECT RAISE(ABORT,'copy_reservation_held'); END;
CREATE TRIGGER copy_job_pin_hold BEFORE UPDATE ON blob_pins
WHEN EXISTS(SELECT 1 FROM copy_job_blobs cb WHERE cb.pin_id=OLD.pin_id)
BEGIN SELECT RAISE(ABORT,'copy_pin_held'); END;
-- Ended jobs retain their immutable manifest. Hold cleanup will be an explicit, R2-aware step.
CREATE TRIGGER copy_job_manifest_delete BEFORE DELETE ON copy_job_manifests
BEGIN SELECT RAISE(ABORT,'copy_manifest_held'); END;
CREATE TRIGGER copy_job_chunk_delete BEFORE DELETE ON copy_job_chunks
BEGIN SELECT RAISE(ABORT,'copy_manifest_held'); END;
CREATE TRIGGER copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
BEGIN SELECT RAISE(ABORT,'copy_hold_unsettled'); END;
CREATE TRIGGER backup_freeze_copy_job_manifests_insert BEFORE INSERT ON copy_job_manifests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_manifests_insert BEFORE INSERT ON copy_job_manifests
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_manifests_update BEFORE UPDATE ON copy_job_manifests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_manifests_update BEFORE UPDATE ON copy_job_manifests
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_manifests_delete BEFORE DELETE ON copy_job_manifests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_manifests_delete BEFORE DELETE ON copy_job_manifests
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_chunks_insert BEFORE INSERT ON copy_job_chunks
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_chunks_insert BEFORE INSERT ON copy_job_chunks
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_chunks_update BEFORE UPDATE ON copy_job_chunks
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_chunks_update BEFORE UPDATE ON copy_job_chunks
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_chunks_delete BEFORE DELETE ON copy_job_chunks
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_chunks_delete BEFORE DELETE ON copy_job_chunks
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
-- A 202 receipt is evidence of durable acceptance, never a claim that the copy has finished.
CREATE TRIGGER operations_copy_enqueue_insert BEFORE INSERT ON operations
WHEN NEW.kind='copy.enqueue' AND (NEW.state<>'claimed' OR NEW.expected_steps<>4)
BEGIN SELECT RAISE(ABORT,'invalid_copy_acceptance'); END;
CREATE TRIGGER operations_copy_enqueue_commit BEFORE UPDATE OF state ON operations
WHEN NEW.kind='copy.enqueue' AND NEW.state='committed' AND NOT EXISTS(
  SELECT 1 FROM bulk_jobs j JOIN copy_job_manifests m ON m.job_id=j.id
    JOIN outbox b ON b.op_id=NEW.op_id AND b.outbox_id=NEW.op_id||'_copy'
  WHERE j.op_id=NEW.op_id AND j.id='copy_'||substr(NEW.op_id,4) AND j.state='pending' AND j.kind='node.copy'
    AND j.credential_id=NEW.credential_id AND j.epoch=NEW.epoch AND j.node_count>=1
    AND b.kind='copy.requested' AND b.payload_ref=j.id AND b.epoch=NEW.epoch AND b.state='pending'
    AND m.chunks=(SELECT COUNT(*) FROM copy_job_chunks WHERE job_id=j.id)
    AND m.bytes=(SELECT SUM(length(data)) FROM copy_job_chunks WHERE job_id=j.id)
    AND j.blob_count=(SELECT COUNT(*) FROM copy_job_blobs WHERE job_id=j.id)
    AND NEW.expected_steps=4 AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=NEW.op_id)=4
    AND (SELECT COUNT(DISTINCT kind) FROM operation_steps WHERE op_id=NEW.op_id AND affected_id=j.id
      AND kind IN ('copy_job','copy_manifest','copy_holds','copy_outbox'))=4
    AND json_extract(NEW.result_json,'$.status')=202 AND json_extract(NEW.result_json,'$.jobId')=j.id
    AND json_type(NEW.result_json,'$.nodeId') IS NULL)
BEGIN SELECT RAISE(ABORT,'incomplete_copy_acceptance'); END;
