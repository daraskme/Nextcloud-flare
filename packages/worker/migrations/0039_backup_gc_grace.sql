-- A namespace snapshot remains eligible for at most 35 days. Retain source
-- objects for at least that long after their last namespace reference disappears.
-- Add one second because the D1 clock below truncates milliseconds.
-- Existing candidate creation dates are unknown: restart their grace here.
-- Never postpone or reverse an already irreversible deletion.
UPDATE gc_candidates SET not_before=MAX(not_before,strftime('%s','now')*1000+3024001000)
WHERE state='candidate';

-- A previously queued blob can be referenced again. Extend its existing deadline
-- when the last node/version reference disappears, in the same transaction.
-- Query authoritative rows rather than depending on accounting trigger order or
-- ref_count, which also includes temporary pins.
CREATE TRIGGER nodes_gc_grace_delete AFTER DELETE ON nodes
WHEN OLD.current_blob_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=OLD.current_blob_id)
 AND NOT EXISTS(SELECT 1 FROM node_versions WHERE blob_id=OLD.current_blob_id)
BEGIN
 UPDATE gc_candidates SET not_before=MAX(not_before,strftime('%s','now')*1000+3024001000)
 WHERE blob_id=OLD.current_blob_id AND state='candidate';
END;

CREATE TRIGGER nodes_gc_grace_update AFTER UPDATE OF current_blob_id ON nodes
WHEN OLD.current_blob_id IS NOT NULL AND NEW.current_blob_id IS NOT OLD.current_blob_id
 AND NOT EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=OLD.current_blob_id)
 AND NOT EXISTS(SELECT 1 FROM node_versions WHERE blob_id=OLD.current_blob_id)
BEGIN
 UPDATE gc_candidates SET not_before=MAX(not_before,strftime('%s','now')*1000+3024001000)
 WHERE blob_id=OLD.current_blob_id AND state='candidate';
END;

CREATE TRIGGER versions_gc_grace_delete AFTER DELETE ON node_versions
WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=OLD.blob_id)
 AND NOT EXISTS(SELECT 1 FROM node_versions WHERE blob_id=OLD.blob_id)
BEGIN
 UPDATE gc_candidates SET not_before=MAX(not_before,strftime('%s','now')*1000+3024001000)
 WHERE blob_id=OLD.blob_id AND state='candidate';
END;
