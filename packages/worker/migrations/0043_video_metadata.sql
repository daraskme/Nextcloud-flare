ALTER TABLE node_media ADD COLUMN container TEXT
  CHECK(container IS NULL OR container IN ('mp4','webm'));
ALTER TABLE node_media ADD COLUMN video_codec TEXT
  CHECK(video_codec IS NULL OR video_codec='av1');
ALTER TABLE node_media ADD COLUMN audio_codec TEXT
  CHECK(audio_codec IS NULL OR audio_codec='opus');
ALTER TABLE node_media ADD COLUMN codec_profile INTEGER
  CHECK(codec_profile IS NULL OR codec_profile BETWEEN 0 AND 2);
ALTER TABLE node_media ADD COLUMN codec_level INTEGER
  CHECK(codec_level IS NULL OR codec_level BETWEEN 0 AND 31);
ALTER TABLE node_media ADD COLUMN codec_tier TEXT
  CHECK(codec_tier IS NULL OR codec_tier IN ('M','H'));
ALTER TABLE node_media ADD COLUMN bit_depth INTEGER
  CHECK(bit_depth IS NULL OR bit_depth IN (8,10,12));
ALTER TABLE node_media ADD COLUMN projection_state TEXT NOT NULL DEFAULT 'ready'
  CHECK(projection_state IN ('ready','failed'));
ALTER TABLE node_media ADD COLUMN error_code TEXT
  CHECK(error_code IS NULL OR error_code IN ('unsupported','malformed','oversized'));

CREATE TRIGGER node_media_video_shape_insert BEFORE INSERT ON node_media
WHEN NEW.generator_version='video-av1-metadata-v1' AND (
  (NEW.projection_state='ready' AND (
    NEW.error_code IS NOT NULL OR
    NEW.width IS NULL OR NEW.height IS NULL OR NEW.width>12000 OR NEW.height>12000 OR
    NEW.width*NEW.height>40000000 OR
    NEW.taken_at IS NOT NULL OR NEW.orientation IS NOT NULL OR NEW.dominant_color IS NOT NULL OR
    NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL OR
    NEW.container IS NULL OR NEW.container NOT IN ('mp4','webm') OR
    NEW.video_codec IS NULL OR NEW.video_codec<>'av1' OR
    (NEW.audio_codec IS NOT NULL AND NEW.audio_codec<>'opus') OR
    NEW.codec_profile IS NULL OR NEW.codec_profile NOT BETWEEN 0 AND 2 OR
    NEW.codec_level IS NULL OR
    (NEW.codec_level NOT BETWEEN 0 AND 23 AND NEW.codec_level<>31) OR
    NEW.codec_tier IS NULL OR NEW.codec_tier NOT IN ('M','H') OR
    NEW.bit_depth IS NULL OR NEW.bit_depth NOT IN (8,10,12) OR
    (NEW.bit_depth=12 AND NEW.codec_profile<>2) OR
    (NEW.codec_tier='H' AND NEW.codec_level<8)
  )) OR
  (NEW.projection_state='failed' AND (
    NEW.error_code IS NULL OR NEW.width IS NOT NULL OR NEW.height IS NOT NULL OR
    NEW.duration_ms IS NOT NULL OR NEW.taken_at IS NOT NULL OR NEW.orientation IS NOT NULL OR
    NEW.dominant_color IS NOT NULL OR NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL OR
    NEW.container IS NOT NULL OR NEW.video_codec IS NOT NULL OR NEW.audio_codec IS NOT NULL OR
    NEW.codec_profile IS NOT NULL OR NEW.codec_level IS NOT NULL OR NEW.codec_tier IS NOT NULL OR
    NEW.bit_depth IS NOT NULL
  ))
)
BEGIN SELECT RAISE(ABORT,'invalid_video_metadata'); END;

CREATE TRIGGER node_media_video_shape_update BEFORE UPDATE ON node_media
WHEN NEW.generator_version='video-av1-metadata-v1' AND (
  (NEW.projection_state='ready' AND (
    NEW.error_code IS NOT NULL OR
    NEW.width IS NULL OR NEW.height IS NULL OR NEW.width>12000 OR NEW.height>12000 OR
    NEW.width*NEW.height>40000000 OR
    NEW.taken_at IS NOT NULL OR NEW.orientation IS NOT NULL OR NEW.dominant_color IS NOT NULL OR
    NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL OR
    NEW.container IS NULL OR NEW.container NOT IN ('mp4','webm') OR
    NEW.video_codec IS NULL OR NEW.video_codec<>'av1' OR
    (NEW.audio_codec IS NOT NULL AND NEW.audio_codec<>'opus') OR
    NEW.codec_profile IS NULL OR NEW.codec_profile NOT BETWEEN 0 AND 2 OR
    NEW.codec_level IS NULL OR
    (NEW.codec_level NOT BETWEEN 0 AND 23 AND NEW.codec_level<>31) OR
    NEW.codec_tier IS NULL OR NEW.codec_tier NOT IN ('M','H') OR
    NEW.bit_depth IS NULL OR NEW.bit_depth NOT IN (8,10,12) OR
    (NEW.bit_depth=12 AND NEW.codec_profile<>2) OR
    (NEW.codec_tier='H' AND NEW.codec_level<8)
  )) OR
  (NEW.projection_state='failed' AND (
    NEW.error_code IS NULL OR NEW.width IS NOT NULL OR NEW.height IS NOT NULL OR
    NEW.duration_ms IS NOT NULL OR NEW.taken_at IS NOT NULL OR NEW.orientation IS NOT NULL OR
    NEW.dominant_color IS NOT NULL OR NEW.camera_make IS NOT NULL OR NEW.camera_model IS NOT NULL OR
    NEW.container IS NOT NULL OR NEW.video_codec IS NOT NULL OR NEW.audio_codec IS NOT NULL OR
    NEW.codec_profile IS NOT NULL OR NEW.codec_level IS NOT NULL OR NEW.codec_tier IS NOT NULL OR
    NEW.bit_depth IS NOT NULL
  ))
)
BEGIN SELECT RAISE(ABORT,'invalid_video_metadata'); END;

CREATE TRIGGER node_media_nonvideo_shape_insert BEFORE INSERT ON node_media
WHEN NEW.generator_version<>'video-av1-metadata-v1' AND (
  NEW.projection_state<>'ready' OR NEW.error_code IS NOT NULL OR
  NEW.container IS NOT NULL OR NEW.video_codec IS NOT NULL OR NEW.audio_codec IS NOT NULL OR
  NEW.codec_profile IS NOT NULL OR NEW.codec_level IS NOT NULL OR NEW.codec_tier IS NOT NULL OR
  NEW.bit_depth IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'invalid_video_metadata'); END;

CREATE TRIGGER node_media_nonvideo_shape_update BEFORE UPDATE ON node_media
WHEN NEW.generator_version<>'video-av1-metadata-v1' AND (
  NEW.projection_state<>'ready' OR NEW.error_code IS NOT NULL OR
  NEW.container IS NOT NULL OR NEW.video_codec IS NOT NULL OR NEW.audio_codec IS NOT NULL OR
  NEW.codec_profile IS NOT NULL OR NEW.codec_level IS NOT NULL OR NEW.codec_tier IS NOT NULL OR
  NEW.bit_depth IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'invalid_video_metadata'); END;
