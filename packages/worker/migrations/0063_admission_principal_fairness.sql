-- Principal fairness: 0061 bounded waiting admissions per space and in total,
-- but every user owns exactly one space, so four accounts could hold all 224
-- non-system slots, and an internal-share recipient (or a public link) acting
-- in someone else's space consumed that owner's per-space allowance.
-- Record who asked (actor: u:<user> | s:<link share>) and who is billed
-- (account: the user, or the space owner for link shares), then bound each:
--   actor 16 / account 32 / link shares per account 16 /
--   non-owner actors per space 48 (owner keeps >=16 of the 64) / total 224.
-- NULL actor = legacy or owner-implicit row; counted toward its space owner's
-- actor/account quotas (rows cannot be backfilled: admission identity is immutable).
ALTER TABLE mutation_admissions ADD COLUMN actor TEXT
  CHECK(actor IS NULL OR (length(actor) BETWEEN 3 AND 130 AND substr(actor,1,2) IN ('u:','s:')));
ALTER TABLE mutation_admissions ADD COLUMN account TEXT CHECK(account IS NULL OR length(account) BETWEEN 1 AND 128);
CREATE INDEX mutation_admissions_actor ON mutation_admissions(state,actor) WHERE actor IS NOT NULL;
CREATE INDEX mutation_admissions_account ON mutation_admissions(state,account) WHERE account IS NOT NULL;
DROP TRIGGER mutation_admission_insert;
CREATE TRIGGER mutation_admission_insert BEFORE INSERT ON mutation_admissions
WHEN NEW.state<>'waiting' OR NEW.granted_at IS NOT NULL
 OR (NEW.system=0 AND substr(NEW.permit_id,1,7) IN ('system:','global:'))
 OR NEW.requested_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=NEW.maintenance AND epoch=NEW.epoch)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=NEW.permit_id)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='waiting')>=256
 OR ((NEW.system=1 OR NEW.space_id IS NULL) AND (NEW.actor IS NOT NULL OR NEW.account IS NOT NULL))
 OR (NEW.actor IS NULL AND NEW.account IS NOT NULL)
 OR (NEW.actor IS NOT NULL AND NEW.account IS NOT (CASE WHEN substr(NEW.actor,1,2)='u:'
   THEN substr(NEW.actor,3) ELSE (SELECT owner_id FROM spaces WHERE id=NEW.space_id) END))
 OR (NEW.system=0 AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND system=0 AND space_id IS NEW.space_id)>=64)
 OR (NEW.system=0 AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND system=0)>=224)
 OR (NEW.actor IS NOT NULL AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND (actor=NEW.actor OR (actor IS NULL AND system=0 AND substr(NEW.actor,1,2)='u:'
     AND space_id IN (SELECT id FROM spaces WHERE owner_id=substr(NEW.actor,3)))))>=16)
 OR (NEW.actor IS NOT NULL AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND (account=NEW.account OR (actor IS NULL AND system=0
     AND space_id IN (SELECT id FROM spaces WHERE owner_id=NEW.account))))>=32)
 OR (substr(NEW.actor,1,2)='s:' AND (SELECT COUNT(*) FROM mutation_admissions
   WHERE state='waiting' AND account=NEW.account AND substr(actor,1,2)='s:')>=16)
 OR (NEW.actor IS NOT NULL AND NEW.actor<>'u:'||(SELECT owner_id FROM spaces WHERE id=NEW.space_id)
   AND (SELECT COUNT(*) FROM mutation_admissions m WHERE m.state='waiting' AND m.system=0
     AND m.space_id=NEW.space_id AND m.actor IS NOT NULL
     AND m.actor<>'u:'||(SELECT owner_id FROM spaces WHERE id=NEW.space_id))>=48)
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;
