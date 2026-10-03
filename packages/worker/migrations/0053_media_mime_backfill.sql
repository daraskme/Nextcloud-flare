-- Existing uploads were projected by bounded media parsers while their blob MIME
-- remained application/octet-stream. Only backfill current, successful projections.
UPDATE blobs SET mime_sniffed='video/mp4'
WHERE mime_sniffed='application/octet-stream'
  AND state IN ('committed','gc_candidate')
  AND EXISTS (
    SELECT 1 FROM nodes n JOIN node_media m ON m.node_id=n.id
    WHERE n.current_blob_id=blobs.id AND n.owner_id=blobs.owner_id
      AND n.kind='file' AND n.deleted_at IS NULL
      AND m.blob_id=blobs.id AND m.generator_version='video-av1-metadata-v1'
      AND m.projection_state='ready' AND m.container='mp4' AND m.video_codec='av1'
  );

UPDATE blobs SET mime_sniffed='video/webm'
WHERE mime_sniffed='application/octet-stream'
  AND state IN ('committed','gc_candidate')
  AND EXISTS (
    SELECT 1 FROM nodes n JOIN node_media m ON m.node_id=n.id
    WHERE n.current_blob_id=blobs.id AND n.owner_id=blobs.owner_id
      AND n.kind='file' AND n.deleted_at IS NULL
      AND m.blob_id=blobs.id AND m.generator_version='video-av1-metadata-v1'
      AND m.projection_state='ready' AND m.container='webm' AND m.video_codec='av1'
  );

UPDATE blobs SET mime_sniffed='audio/mpeg'
WHERE mime_sniffed='application/octet-stream'
  AND state IN ('committed','gc_candidate')
  AND EXISTS (
    SELECT 1 FROM nodes n JOIN node_audio a ON a.node_id=n.id
    WHERE n.current_blob_id=blobs.id AND n.owner_id=blobs.owner_id
      AND n.kind='file' AND n.deleted_at IS NULL
      AND a.blob_id=blobs.id AND a.generator_version='ncf-id3-1' AND a.codec='mp3'
  )
  AND NOT EXISTS (
    SELECT 1 FROM nodes n JOIN node_media m ON m.node_id=n.id
    WHERE n.current_blob_id=blobs.id AND n.owner_id=blobs.owner_id
      AND n.kind='file' AND n.deleted_at IS NULL
      AND m.blob_id=blobs.id AND m.generator_version='video-av1-metadata-v1'
      AND m.projection_state='ready' AND m.video_codec='av1'
  );
