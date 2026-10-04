-- Admission fairness: the 256-waiting/32-active caps are table-wide, so a single
-- caller flooding fresh permit ids could stall every space plus system/global
-- admissions (GC, tree jobs, scans). Bound non-system waiting per space (64) and
-- in total (224) so 32 slots always remain for system and global admissions.
DROP TRIGGER mutation_admission_insert;
CREATE TRIGGER mutation_admission_insert BEFORE INSERT ON mutation_admissions
WHEN NEW.state<>'waiting' OR NEW.granted_at IS NOT NULL
 OR (NEW.system=0 AND substr(NEW.permit_id,1,7) IN ('system:','global:'))
 OR NEW.requested_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=NEW.maintenance AND epoch=NEW.epoch)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=NEW.permit_id)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='waiting')>=256
 OR (NEW.system=0 AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND system=0 AND space_id IS NEW.space_id)>=64)
 OR (NEW.system=0 AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND system=0)>=224)
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;
