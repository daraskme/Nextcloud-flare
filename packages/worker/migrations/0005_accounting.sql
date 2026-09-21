-- Reference and capacity counters are changed with their authoritative rows.
-- This migration precedes the first physical-object accounting implementation.
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM users WHERE physical_bytes<>0);
CREATE TABLE blob_storage(
  blob_id TEXT NOT NULL PRIMARY KEY REFERENCES blobs(id),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991),
  r2_etag TEXT NOT NULL CHECK(length(r2_etag) BETWEEN 1 AND 256),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),
  removed_at INTEGER CHECK(removed_at>=observed_at)
) STRICT;

UPDATE blobs SET ref_count=(SELECT COUNT(*) FROM nodes WHERE current_blob_id=blobs.id)
  +(SELECT COUNT(*) FROM node_versions WHERE blob_id=blobs.id)
  +(SELECT COUNT(*) FROM blob_pins WHERE blob_id=blobs.id);
UPDATE users SET used_bytes=COALESCE((SELECT SUM(size) FROM blobs b WHERE b.owner_id=users.id AND
  (EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=b.id) OR EXISTS(SELECT 1 FROM node_versions WHERE blob_id=b.id))),0),
  reserved_bytes=COALESCE((SELECT SUM(bytes) FROM reservations WHERE owner_id=users.id AND state='reserved'),0);
UPDATE shares SET reserved_bytes=COALESCE((SELECT SUM(bytes) FROM reservations WHERE share_id=shares.id AND state='reserved'),0);

CREATE TRIGGER reservations_insert_guard BEFORE INSERT ON reservations WHEN NEW.state<>'reserved'
BEGIN SELECT RAISE(ABORT,'reservation_must_start_reserved'); END;
CREATE TRIGGER reservations_identity BEFORE UPDATE OF id,owner_id,share_id,bytes,epoch,expires_at ON reservations
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.share_id IS NOT OLD.share_id OR NEW.bytes<>OLD.bytes
 OR NEW.epoch<>OLD.epoch OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'immutable_reservation'); END;
CREATE TRIGGER reservations_terminal BEFORE UPDATE OF state ON reservations
WHEN OLD.state<>'reserved' AND NEW.state<>OLD.state
BEGIN SELECT RAISE(ABORT,'terminal_reservation'); END;
CREATE TRIGGER reservations_delete_guard BEFORE DELETE ON reservations WHEN OLD.state='reserved'
BEGIN SELECT RAISE(ABORT,'release_reservation_first'); END;
CREATE TRIGGER reservations_charge AFTER INSERT ON reservations
BEGIN
  UPDATE users SET reserved_bytes=reserved_bytes+NEW.bytes WHERE id=NEW.owner_id AND disabled_at IS NULL
    AND used_bytes<=quota_bytes-reserved_bytes-NEW.bytes
    AND physical_bytes<=quota_bytes*6/5-reserved_bytes-NEW.bytes;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'quota_exceeded') END;
  UPDATE shares SET reserved_bytes=reserved_bytes+NEW.bytes WHERE id=NEW.share_id AND owner_id=NEW.owner_id
    AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000)
    AND reserved_bytes<=reservation_limit-NEW.bytes;
  SELECT CASE WHEN NEW.share_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'share_quota_exceeded') END;
END;
CREATE TRIGGER reservations_uncharge AFTER UPDATE OF state ON reservations
WHEN OLD.state='reserved' AND NEW.state IN ('consumed','released')
BEGIN
  UPDATE users SET reserved_bytes=reserved_bytes-OLD.bytes WHERE id=OLD.owner_id AND reserved_bytes>=OLD.bytes;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reservation_counter_drift') END;
  UPDATE shares SET reserved_bytes=reserved_bytes-OLD.bytes WHERE id=OLD.share_id AND reserved_bytes>=OLD.bytes;
  SELECT CASE WHEN OLD.share_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'share_reservation_counter_drift') END;
END;

CREATE TRIGGER blob_storage_insert_guard BEFORE INSERT ON blob_storage
WHEN NEW.removed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state<>'deleted')
BEGIN SELECT RAISE(ABORT,'invalid_physical_observation'); END;
CREATE TRIGGER blob_storage_identity BEFORE UPDATE OF blob_id,bytes,r2_etag,observed_at ON blob_storage
WHEN NEW.blob_id<>OLD.blob_id OR NEW.bytes<>OLD.bytes OR NEW.r2_etag<>OLD.r2_etag OR NEW.observed_at<>OLD.observed_at
BEGIN SELECT RAISE(ABORT,'immutable_physical_observation'); END;
CREATE TRIGGER blob_storage_terminal BEFORE UPDATE OF removed_at ON blob_storage
WHEN (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
 OR (NEW.removed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state='deleted'))
BEGIN SELECT RAISE(ABORT,'physical_removal_requires_deleted_blob'); END;
CREATE TRIGGER blob_storage_delete_guard BEFORE DELETE ON blob_storage WHEN OLD.removed_at IS NULL
BEGIN SELECT RAISE(ABORT,'physical_object_still_present'); END;
CREATE TRIGGER blob_storage_charge AFTER INSERT ON blob_storage
BEGIN
  -- R2 bytes already exist: account them even if an operator lowered quota.
  UPDATE users SET physical_bytes=physical_bytes+NEW.bytes
    WHERE id=(SELECT owner_id FROM blobs WHERE id=NEW.blob_id);
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'physical_counter_drift') END;
END;
CREATE TRIGGER blob_storage_uncharge AFTER UPDATE OF removed_at ON blob_storage
WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
BEGIN
  UPDATE users SET physical_bytes=physical_bytes-NEW.bytes
    WHERE id=(SELECT owner_id FROM blobs WHERE id=NEW.blob_id)
      AND physical_bytes>=NEW.bytes;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'physical_counter_drift') END;
END;

CREATE TRIGGER nodes_reference_insert AFTER INSERT ON nodes WHEN NEW.current_blob_id IS NOT NULL
BEGIN
  UPDATE users SET used_bytes=used_bytes+(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=NEW.current_blob_id) AND ((SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id)=0 OR used_bytes<=quota_bytes-reserved_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id));
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count+1 WHERE id=NEW.current_blob_id AND ref_count<1000 AND state NOT IN ('deleting','deleted');
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER nodes_reference_delete AFTER DELETE ON nodes WHEN OLD.current_blob_id IS NOT NULL
BEGIN
  UPDATE users SET used_bytes=used_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.current_blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.current_blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=OLD.current_blob_id) AND used_bytes>=(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.current_blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.current_blob_id);
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count-1 WHERE id=OLD.current_blob_id AND ref_count>0;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER nodes_reference_update AFTER UPDATE OF current_blob_id ON nodes
WHEN NEW.current_blob_id IS NOT OLD.current_blob_id
BEGIN
  UPDATE users SET used_bytes=used_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.current_blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.current_blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=OLD.current_blob_id) AND used_bytes>=(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.current_blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.current_blob_id);
  SELECT CASE WHEN OLD.current_blob_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count-1 WHERE id=OLD.current_blob_id AND ref_count>0;
  SELECT CASE WHEN OLD.current_blob_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
  UPDATE users SET used_bytes=used_bytes+(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=NEW.current_blob_id) AND ((SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id)=0 OR used_bytes<=quota_bytes-reserved_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.current_blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.current_blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.current_blob_id));
  SELECT CASE WHEN NEW.current_blob_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count+1 WHERE id=NEW.current_blob_id AND ref_count<1000 AND state NOT IN ('deleting','deleted');
  SELECT CASE WHEN NEW.current_blob_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER node_versions_reference_insert AFTER INSERT ON node_versions
BEGIN
  UPDATE users SET used_bytes=used_bytes+(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=NEW.blob_id) AND ((SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.blob_id)=0 OR used_bytes<=quota_bytes-reserved_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=NEW.blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=NEW.blob_id))=1 THEN size ELSE 0 END FROM blobs WHERE id=NEW.blob_id));
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count+1 WHERE id=NEW.blob_id AND ref_count<1000 AND state NOT IN ('deleting','deleted');
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER node_versions_reference_delete AFTER DELETE ON node_versions
BEGIN
  UPDATE users SET used_bytes=used_bytes-(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.blob_id)
    WHERE id=(SELECT owner_id FROM blobs WHERE id=OLD.blob_id) AND used_bytes>=(SELECT CASE WHEN ((SELECT COUNT(*) FROM nodes WHERE current_blob_id=OLD.blob_id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=OLD.blob_id))=0 THEN size ELSE 0 END FROM blobs WHERE id=OLD.blob_id);
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'logical_counter_or_quota') END;
  UPDATE blobs SET ref_count=ref_count-1 WHERE id=OLD.blob_id AND ref_count>0;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER blob_pins_reference_insert AFTER INSERT ON blob_pins
BEGIN
  UPDATE blobs SET ref_count=ref_count+1 WHERE id=NEW.blob_id AND ref_count<1000 AND state NOT IN ('deleting','deleted');
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
CREATE TRIGGER blob_pins_reference_delete AFTER DELETE ON blob_pins
BEGIN
  UPDATE blobs SET ref_count=ref_count-1 WHERE id=OLD.blob_id AND ref_count>0;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reference_counter_or_limit') END;
END;
