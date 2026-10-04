CREATE TABLE user_audio_chapter_sets(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 604800000),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE(user_id,node_id,blob_id)
) STRICT;

CREATE INDEX user_audio_chapter_sets_user_id_fk ON user_audio_chapter_sets(user_id);
CREATE INDEX user_audio_chapter_sets_node_id_fk ON user_audio_chapter_sets(node_id);
CREATE INDEX user_audio_chapter_sets_blob_id_fk ON user_audio_chapter_sets(blob_id);

CREATE TABLE user_audio_chapters(
  set_id TEXT NOT NULL REFERENCES user_audio_chapter_sets(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  position_ms INTEGER NOT NULL CHECK(position_ms BETWEEN 0 AND 604800000),
  title TEXT NOT NULL CHECK(length(title)>0 AND length(CAST(title AS BLOB))<=256),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 199),
  PRIMARY KEY(set_id,chapter_id),
  UNIQUE(set_id,sort_order)
) STRICT;

CREATE TRIGGER user_audio_chapter_sets_identity
BEFORE UPDATE OF id,user_id,node_id,blob_id ON user_audio_chapter_sets
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.node_id<>OLD.node_id
  OR NEW.blob_id<>OLD.blob_id
BEGIN SELECT RAISE(ABORT,'immutable_user_audio_chapter_set_identity'); END;

CREATE TRIGGER backup_freeze_user_audio_chapter_sets_insert
BEFORE INSERT ON user_audio_chapter_sets
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_audio_chapter_sets_update
BEFORE UPDATE ON user_audio_chapter_sets
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_audio_chapter_sets_delete
BEFORE DELETE ON user_audio_chapter_sets
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_audio_chapters_insert
BEFORE INSERT ON user_audio_chapters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_audio_chapters_update
BEFORE UPDATE ON user_audio_chapters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_audio_chapters_delete
BEFORE DELETE ON user_audio_chapters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;

INSERT INTO operation_kinds(name) VALUES('audio_chapters.write');
