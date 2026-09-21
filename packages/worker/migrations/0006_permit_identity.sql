-- No namespace permit had been issued by the application before this migration.
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM permits WHERE state='open');
CREATE UNIQUE INDEX permits_one_open_per_space ON permits(space_id) WHERE state='open';
CREATE TRIGGER permits_identity BEFORE UPDATE OF permit_id,space_id,epoch,expires_at ON permits
WHEN NEW.permit_id<>OLD.permit_id OR NEW.space_id<>OLD.space_id OR NEW.epoch<>OLD.epoch OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'immutable_permit'); END;
