-- Completion records refer to the exact immutable R2 publication verified by ControlDO.
CREATE TRIGGER backup_completion_insert BEFORE INSERT ON backup_runs
WHEN NEW.state='completed' AND (
 NEW.barrier_token IS NULL OR NEW.released_at IS NULL OR NEW.completed_at IS NULL
 OR NEW.completed_at<NEW.created_at
 OR NEW.manifest_key IS NOT 'sys/backups/v1/'||NEW.id||'/manifest.json'
 OR NEW.manifest_sha256 IS NULL OR length(NEW.manifest_sha256)<>64
 OR NEW.manifest_sha256 GLOB '*[^0-9a-f]*')
BEGIN SELECT RAISE(ABORT,'invalid_backup_completion'); END;
CREATE TRIGGER backup_completion_update BEFORE UPDATE ON backup_runs
WHEN NEW.state='completed' AND (
 NEW.barrier_token IS NULL OR NEW.released_at IS NULL OR NEW.completed_at IS NULL
 OR NEW.completed_at<NEW.created_at
 OR NEW.manifest_key IS NOT 'sys/backups/v1/'||NEW.id||'/manifest.json'
 OR NEW.manifest_sha256 IS NULL OR length(NEW.manifest_sha256)<>64
 OR NEW.manifest_sha256 GLOB '*[^0-9a-f]*')
BEGIN SELECT RAISE(ABORT,'invalid_backup_completion'); END;
CREATE TRIGGER backup_terminal_receipt BEFORE UPDATE ON backup_runs
WHEN OLD.state IN ('completed','failed') AND (
 NEW.manifest_key IS NOT OLD.manifest_key OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
 OR NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'immutable_backup_receipt'); END;
