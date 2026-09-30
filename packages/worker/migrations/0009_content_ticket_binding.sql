-- A content session is redeemable only through the ticket that created it.
ALTER TABLE content_sessions ADD COLUMN ticket_id TEXT REFERENCES tickets(id);
CREATE INDEX content_sessions_ticket_id_fk ON content_sessions(ticket_id);
CREATE TRIGGER content_sessions_ticket_required BEFORE INSERT ON content_sessions
WHEN NEW.ticket_id IS NULL BEGIN SELECT RAISE(ABORT,'content_ticket_required'); END;
CREATE TRIGGER content_sessions_ticket_preserved BEFORE UPDATE OF ticket_id ON content_sessions
WHEN NEW.ticket_id IS NULL BEGIN SELECT RAISE(ABORT,'content_ticket_required'); END;
