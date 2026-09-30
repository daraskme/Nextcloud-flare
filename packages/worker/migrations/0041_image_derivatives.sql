-- Gallery image metadata is deliberately width/height-only. Rich EXIF remains deferred.
ALTER TABLE derivative_results ADD COLUMN r2_etag TEXT
  CHECK(r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 256);

CREATE INDEX derivative_results_gc
  ON derivative_results(blob_id,state,kind,variant,generator_version);

CREATE TRIGGER node_media_image_shape_insert BEFORE INSERT ON node_media
WHEN NEW.generator_version='image-metadata-v1' AND (
  NEW.width IS NULL OR NEW.height IS NULL OR NEW.width>12000 OR NEW.height>12000 OR
  NEW.width*NEW.height>40000000 OR
  NEW.taken_at IS NOT NULL OR NEW.duration_ms IS NOT NULL OR NEW.orientation IS NOT NULL OR
  NEW.dominant_color IS NOT NULL OR NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'invalid_image_metadata'); END;

CREATE TRIGGER node_media_image_shape_update BEFORE UPDATE ON node_media
WHEN NEW.generator_version='image-metadata-v1' AND (
  NEW.width IS NULL OR NEW.height IS NULL OR NEW.width>12000 OR NEW.height>12000 OR
  NEW.width*NEW.height>40000000 OR
  NEW.taken_at IS NOT NULL OR NEW.duration_ms IS NOT NULL OR NEW.orientation IS NOT NULL OR
  NEW.dominant_color IS NOT NULL OR NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'invalid_image_metadata'); END;

CREATE TRIGGER derivative_image_shape_insert BEFORE INSERT ON derivative_results
WHEN NEW.kind='thumbnail' AND NEW.variant='sm256' AND (
  NEW.generator_version<>'image-sm256-v1' OR
  (NEW.state='pending' AND (
    NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL OR NEW.attempts<>0 OR
    NEW.r2_key IS NOT NULL OR NEW.size IS NOT NULL OR NEW.r2_etag IS NOT NULL OR NEW.error_code IS NOT NULL
  )) OR
  (NEW.state='running' AND (
    NEW.claim_token IS NULL OR NEW.claim_expires_at IS NULL OR NEW.attempts NOT BETWEEN 1 AND 3 OR
    NEW.r2_key IS NOT NULL OR NEW.size IS NOT NULL OR NEW.r2_etag IS NOT NULL OR NEW.error_code IS NOT NULL
  )) OR
  (NEW.state='ready' AND (
    NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL OR NEW.attempts NOT BETWEEN 1 AND 3 OR
    NEW.r2_key IS NULL OR NEW.size IS NULL OR NEW.size NOT BETWEEN 1 AND 2000000 OR
    NEW.r2_etag IS NULL OR NEW.error_code IS NOT NULL OR
    substr(NEW.r2_key,1,length((SELECT 'u/'||owner_id||'/d/'||id||'/image-sm256-v1/sm256/' FROM blobs WHERE id=NEW.blob_id)))
      <>(SELECT 'u/'||owner_id||'/d/'||id||'/image-sm256-v1/sm256/' FROM blobs WHERE id=NEW.blob_id) OR
    substr(NEW.r2_key,-5)<>'.webp'
  )) OR
  (NEW.state='failed' AND (
    NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL OR NEW.attempts NOT BETWEEN 0 AND 3 OR
    NEW.r2_key IS NOT NULL OR NEW.size IS NOT NULL OR NEW.r2_etag IS NOT NULL OR NEW.error_code IS NULL
  ))
)
BEGIN SELECT RAISE(ABORT,'invalid_image_derivative'); END;

CREATE TRIGGER derivative_image_shape_update BEFORE UPDATE ON derivative_results
WHEN NEW.kind='thumbnail' AND NEW.variant='sm256' AND (
  NEW.id<>OLD.id OR NEW.blob_id<>OLD.blob_id OR NEW.kind<>OLD.kind OR
  NEW.variant<>OLD.variant OR NEW.generator_version<>OLD.generator_version OR NEW.epoch<>OLD.epoch OR
  OLD.state IN ('ready','failed') OR
  (OLD.state='pending' AND NEW.state NOT IN ('running','failed')) OR
  (OLD.state='running' AND NEW.state NOT IN ('running','ready','failed')) OR
  (NEW.state='running' AND (
    NEW.claim_token IS NULL OR NEW.claim_expires_at IS NULL OR NEW.attempts NOT BETWEEN 1 AND 3 OR
    NEW.r2_key IS NOT NULL OR NEW.size IS NOT NULL OR NEW.r2_etag IS NOT NULL OR NEW.error_code IS NOT NULL
  )) OR
  (NEW.state='ready' AND (
    OLD.claim_token IS NULL OR NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL OR
    NEW.attempts NOT BETWEEN 1 AND 3 OR
    NEW.r2_key IS NULL OR NEW.size IS NULL OR NEW.size NOT BETWEEN 1 AND 2000000 OR
    NEW.r2_etag IS NULL OR NEW.error_code IS NOT NULL OR
    NEW.r2_key<>(SELECT 'u/'||owner_id||'/d/'||id||'/image-sm256-v1/sm256/'||OLD.claim_token||'.webp'
      FROM blobs WHERE id=NEW.blob_id)
  )) OR
  (NEW.state='failed' AND (
    NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL OR NEW.attempts NOT BETWEEN 0 AND 3 OR
    NEW.r2_key IS NOT NULL OR NEW.size IS NOT NULL OR NEW.r2_etag IS NOT NULL OR NEW.error_code IS NULL
  ))
)
BEGIN SELECT RAISE(ABORT,'invalid_image_derivative'); END;
