INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
-- Namespace publication uses the destination space permit, separately from the 202 receipt.
INSERT INTO operation_kinds VALUES('copy.publish');
ALTER TABLE bulk_jobs ADD COLUMN publish_op_id TEXT REFERENCES operations(op_id);
ALTER TABLE bulk_jobs ADD COLUMN published_root_id TEXT;
CREATE UNIQUE INDEX bulk_jobs_publication ON bulk_jobs(publish_op_id);
CREATE TRIGGER copy_publication_initial BEFORE INSERT ON bulk_jobs
WHEN NEW.publish_op_id IS NOT NULL OR NEW.published_root_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_copy_publication'); END;
CREATE TRIGGER copy_publication_identity BEFORE UPDATE ON bulk_jobs
WHEN (OLD.publish_op_id IS NOT NULL AND (NEW.publish_op_id IS NOT OLD.publish_op_id OR NEW.published_root_id IS NOT OLD.published_root_id))
  OR (OLD.kind='node.copy' AND OLD.state='completed' AND NEW.state<>'completed')
  OR (NEW.publish_op_id IS NULL)<>(NEW.published_root_id IS NULL)
  OR (NEW.publish_op_id IS NOT NULL AND NEW.kind<>'node.copy')
BEGIN SELECT RAISE(ABORT,'immutable_copy_publication'); END;
CREATE TRIGGER copy_publication_begin BEFORE UPDATE OF publish_op_id ON bulk_jobs
WHEN OLD.publish_op_id IS NULL AND NEW.publish_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operations p JOIN operations a ON a.op_id=NEW.op_id
    JOIN permits permit ON permit.permit_id=p.permit_id JOIN control c ON c.singleton=1
    JOIN job_leases l ON l.job_id=NEW.id JOIN copy_job_manifests m ON m.job_id=NEW.id
  WHERE p.op_id=NEW.publish_op_id AND p.kind='copy.publish' AND p.state='claimed'
    AND p.principal_kind='user' AND p.principal_id=a.principal_id AND p.credential_id=NEW.credential_id
    AND p.space_id=a.destination_space_id AND p.destination_space_id IS NULL
    AND p.selected_share_id IS a.destination_share_id AND p.selected_share_version IS a.destination_share_version
    AND p.epoch=NEW.epoch AND p.expected_steps=10 AND a.state='committed' AND a.kind='copy.enqueue'
    AND json_extract(p.operands_json,'$.jobId')=NEW.id
    AND json_extract(p.operands_json,'$.manifestDigest')=m.sha256
    AND json_extract(p.operands_json,'$.parentId')=json_extract(a.operands_json,'$.parentId')
    AND json_extract(p.operands_json,'$.overwriteTargetId') IS json_extract(a.operands_json,'$.overwriteTargetId')
    AND NEW.published_root_id=NEW.id||'_n00001'
    AND OLD.state='running' AND NEW.state='running' AND c.epoch=NEW.epoch AND c.maintenance=0
    AND permit.state='open' AND permit.space_id=p.space_id AND permit.epoch=p.epoch
    AND permit.expires_at=p.permit_expires_at AND permit.expires_at>strftime('%s','now')*1000
    AND l.epoch=NEW.epoch AND l.expires_at>strftime('%s','now')*1000 AND m.expires_at>strftime('%s','now')*1000
    AND json_extract(p.operands_json,'$.claimToken')=l.claim_token
    AND NEW.checkpoint=json_object('v',1,'blob',NEW.blob_count,'offset',0)
)
BEGIN SELECT RAISE(ABORT,'copy_publication_unproven'); END;
CREATE TRIGGER copy_publication_ready BEFORE UPDATE OF publish_op_id ON bulk_jobs
WHEN OLD.publish_op_id IS NULL AND NEW.publish_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM copy_job_manifests m WHERE m.job_id=NEW.id
    AND NEW.blob_count=(SELECT COUNT(*) FROM copy_job_blobs WHERE job_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id
      JOIN r2_write_attempts w ON w.r2_key=b.r2_key WHERE cb.job_id=NEW.id AND w.state='pending')
    AND NEW.blob_count=(SELECT COUNT(*) FROM copy_job_blobs cb
      JOIN blobs b ON b.id=cb.destination_blob_id JOIN blobs source ON source.id=cb.source_blob_id
      JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins pin ON pin.pin_id=cb.pin_id
      JOIN reservations r ON r.id=cb.reservation_id LEFT JOIN copy_multipart_uploads mp ON mp.destination_blob_id=b.id
      WHERE cb.job_id=NEW.id AND cb.transfer_state='stored' AND b.state='staging' AND b.ref_count=0
        AND b.owner_id=NEW.owner_id AND b.size=source.size AND s.bytes=b.size AND s.removed_at IS NULL
        AND pin.blob_id=source.id AND pin.purpose='copy' AND pin.expires_at=m.expires_at
        AND r.owner_id=NEW.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.epoch=NEW.epoch
        AND ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
          OR (cb.transfer_mode='multipart' AND mp.state='stored' AND mp.object_etag=s.r2_etag AND b.sha256_verified IS NULL))
        AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
          WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
            AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE mp.complete_attempt END)
            AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=NEW.owner_id)))
BEGIN SELECT RAISE(ABORT,'copy_publication_unproven'); END;

-- Convert reserved quota to used quota inside the same atomic namespace batch.
DROP TRIGGER copy_job_reservation_hold;
CREATE TRIGGER copy_job_reservation_hold BEFORE UPDATE ON reservations
WHEN EXISTS(SELECT 1 FROM copy_job_blobs WHERE reservation_id=OLD.id) AND (
  NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.bytes<>OLD.bytes OR NEW.epoch<>OLD.epoch
  OR NEW.expires_at<>OLD.expires_at OR NEW.share_id IS NOT OLD.share_id OR NEW.op_id IS NOT OLD.op_id
  OR (NEW.state<>OLD.state AND NOT EXISTS(
    SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
      JOIN operations o ON o.op_id=j.publish_op_id JOIN permits p ON p.permit_id=o.permit_id
      JOIN blobs b ON b.id=cb.destination_blob_id JOIN control c ON c.singleton=1
    WHERE cb.reservation_id=OLD.id AND cb.transfer_state='stored' AND j.state='running'
      AND OLD.state='reserved' AND NEW.state='released' AND o.kind='copy.publish' AND o.state='claimed'
      AND o.epoch=j.epoch AND c.epoch=j.epoch AND c.maintenance=0
      AND p.state='open' AND p.expires_at>strftime('%s','now')*1000
      AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key=b.r2_key AND w.state='pending'))))
BEGIN SELECT RAISE(ABORT,'copy_reservation_held'); END;

CREATE TRIGGER copy_publication_complete BEFORE UPDATE OF state ON bulk_jobs
WHEN NEW.kind='node.copy' AND NEW.state='completed' AND OLD.state<>'completed' AND NOT EXISTS(
  SELECT 1 FROM operations o JOIN outbox b ON b.outbox_id=o.op_id||'_event'
    JOIN activity a ON a.id=o.op_id||'_activity'
  WHERE o.op_id=NEW.publish_op_id AND o.kind='copy.publish' AND o.state='claimed' AND o.expected_steps=10
    AND b.op_id=o.op_id AND b.kind='node.created' AND b.payload_ref=NEW.published_root_id AND b.state='pending'
    AND a.op_id=o.op_id AND a.affected_id=NEW.published_root_id
    AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=o.op_id)=10
    AND NEW.node_count=(SELECT COUNT(*) FROM nodes WHERE last_op_id=o.op_id AND id>=NEW.id||'_n' AND id<NEW.id||'_o' AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN reservations r ON r.id=cb.reservation_id
      JOIN blobs x ON x.id=cb.destination_blob_id WHERE cb.job_id=NEW.id AND (r.state<>'released' OR x.state<>'committed' OR x.ref_count<1)))
BEGIN SELECT RAISE(ABORT,'incomplete_copy_publication'); END;
CREATE TRIGGER operations_copy_publish_insert BEFORE INSERT ON operations
WHEN NEW.kind='copy.publish' AND (NEW.state<>'claimed' OR NEW.expected_steps<>10 OR NEW.principal_kind<>'user')
BEGIN SELECT RAISE(ABORT,'invalid_copy_publication'); END;
CREATE TRIGGER operations_copy_publish_commit BEFORE UPDATE OF state ON operations
WHEN NEW.kind='copy.publish' AND NEW.state='committed' AND NOT EXISTS(
  SELECT 1 FROM bulk_jobs j WHERE j.publish_op_id=NEW.op_id AND j.state='completed'
    AND j.published_root_id=json_extract(NEW.result_json,'$.nodeId') AND j.id=json_extract(NEW.operands_json,'$.jobId')
    AND json_extract(NEW.result_json,'$.status')=CASE WHEN json_type(NEW.operands_json,'$.overwriteTargetId')='text' THEN 204 ELSE 201 END)
BEGIN SELECT RAISE(ABORT,'incomplete_copy_publication'); END;

-- Only a committed publication can drop native transfer metadata and source holds.
DROP TRIGGER copy_job_blobs_delete;
CREATE TRIGGER copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN NOT EXISTS(SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.publish_op_id
  JOIN blobs b ON b.id=OLD.destination_blob_id JOIN reservations r ON r.id=OLD.reservation_id
  WHERE j.id=OLD.job_id AND j.state='completed' AND o.kind='copy.publish' AND o.state='committed'
    AND b.state='committed' AND b.ref_count>0 AND r.state='released'
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key=b.r2_key AND w.state='pending'))
BEGIN SELECT RAISE(ABORT,'copy_hold_unsettled'); END;
DROP TRIGGER copy_multipart_delete;
CREATE TRIGGER copy_multipart_delete BEFORE DELETE ON copy_multipart_uploads
WHEN OLD.state<>'stored' OR NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN operations o ON o.op_id=j.publish_op_id WHERE cb.destination_blob_id=OLD.destination_blob_id
    AND j.state='completed' AND o.kind='copy.publish' AND o.state='committed')
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
DROP TRIGGER copy_part_delete;
CREATE TRIGGER copy_part_delete BEFORE DELETE ON copy_multipart_parts
WHEN NOT EXISTS(SELECT 1 FROM copy_multipart_uploads m JOIN copy_job_blobs cb ON cb.destination_blob_id=m.destination_blob_id
  JOIN bulk_jobs j ON j.id=cb.job_id JOIN operations o ON o.op_id=j.publish_op_id
  WHERE m.destination_blob_id=OLD.destination_blob_id AND m.state='stored' AND j.state='completed'
    AND o.kind='copy.publish' AND o.state='committed')
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
