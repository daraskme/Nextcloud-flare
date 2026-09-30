-- Keep the owner-wide content budget cap atomic under concurrent ticket creation.
CREATE INDEX budgets_owner_state_expiry ON budgets(owner_id,state,expires_at);
CREATE TRIGGER budgets_owner_active_cap_insert BEFORE INSERT ON budgets
WHEN NEW.state='active' AND NEW.expires_at>strftime('%s','now')*1000
  AND (SELECT COUNT(*) FROM budgets
       WHERE owner_id=NEW.owner_id AND state='active'
         AND expires_at>strftime('%s','now')*1000)>=64
BEGIN SELECT RAISE(ABORT,'owner_budget_limit'); END;
CREATE TRIGGER budgets_owner_active_cap_update BEFORE UPDATE OF owner_id,state,expires_at ON budgets
WHEN NEW.state='active' AND NEW.expires_at>strftime('%s','now')*1000
  AND (SELECT COUNT(*) FROM budgets
       WHERE owner_id=NEW.owner_id AND id<>OLD.id AND state='active'
         AND expires_at>strftime('%s','now')*1000)>=64
BEGIN SELECT RAISE(ABORT,'owner_budget_limit'); END;
