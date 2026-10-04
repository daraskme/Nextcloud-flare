ALTER TABLE tickets ADD COLUMN redeemed_at INTEGER CHECK(redeemed_at>=0);
UPDATE tickets SET redeemed_at=(SELECT MIN(cs.issued_at) FROM content_sessions cs WHERE cs.ticket_id=tickets.id)
WHERE EXISTS(SELECT 1 FROM content_sessions cs WHERE cs.ticket_id=tickets.id);
CREATE INDEX content_sessions_credential_expiry ON content_sessions(issued_by_credential_id,expires_at);
CREATE INDEX content_sessions_expiry ON content_sessions(expires_at);
