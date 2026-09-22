-- Active locks live for at most one hour. Drain them before adding the required display URI.
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM locks);
ALTER TABLE locks ADD COLUMN display_href TEXT
  CHECK(display_href IS NULL OR (length(CAST(display_href AS BLOB)) BETWEEN 5 AND 16384 AND substr(display_href,1,5)='/dav/'));
CREATE TRIGGER locks_display_href_required_insert BEFORE INSERT ON locks
WHEN NEW.display_href IS NULL BEGIN SELECT RAISE(ABORT,'lock_display_href_required'); END;
CREATE TRIGGER locks_display_href_required_update BEFORE UPDATE OF display_href ON locks
WHEN NEW.display_href IS NULL BEGIN SELECT RAISE(ABORT,'lock_display_href_required'); END;
