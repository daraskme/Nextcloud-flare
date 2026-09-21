ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'link' CHECK(kind IN ('link','user'));
ALTER TABLE shares ADD COLUMN link_secret_digest TEXT;
ALTER TABLE shares ADD COLUMN mount_name TEXT NOT NULL DEFAULT '';
ALTER TABLE share_sessions ADD COLUMN budget_id TEXT;
ALTER TABLE share_sessions ADD COLUMN budget_max_bytes INTEGER CHECK(budget_max_bytes IS NULL OR budget_max_bytes>=0);
ALTER TABLE uploads ADD COLUMN share_id TEXT REFERENCES shares(id);
ALTER TABLE uploads ADD COLUMN share_version INTEGER;
CREATE INDEX uploads_share_state ON uploads(share_id,state,expires_at);

CREATE TABLE content_tickets(
  id TEXT NOT NULL PRIMARY KEY,
  issuer_session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT REFERENCES users(id),
  share_id TEXT REFERENCES shares(id),
  share_version INTEGER,
  target_set_id TEXT NOT NULL REFERENCES content_target_sets(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('content','thumb','page','zip','track')),
  budget_id TEXT NOT NULL,
  max_bytes INTEGER NOT NULL CHECK(max_bytes>=0),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  expires_at INTEGER NOT NULL,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(user_id IS NOT NULL OR share_id IS NOT NULL)
) STRICT;
CREATE INDEX content_tickets_issuer ON content_tickets(issuer_session_id,canceled_at,expires_at);
CREATE INDEX content_tickets_target ON content_tickets(target_set_id);
ALTER TABLE content_sessions ADD COLUMN ticket_id TEXT REFERENCES content_tickets(id);

CREATE TABLE zip_manifests(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  issuer_session_id TEXT NOT NULL REFERENCES sessions(id),
  share_id TEXT REFERENCES shares(id),
  share_version INTEGER,
  root_node_id TEXT NOT NULL REFERENCES nodes(id),
  entries_json TEXT NOT NULL CHECK(length(entries_json)<=2000000),
  manifest_hash TEXT NOT NULL,
  output_size INTEGER NOT NULL CHECK(output_size BETWEEN 0 AND 4294967295),
  budget_id TEXT NOT NULL,
  max_bytes INTEGER NOT NULL CHECK(max_bytes>=0),
  expires_at INTEGER NOT NULL,
  canceled_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX zip_manifests_issuer ON zip_manifests(issuer_session_id,canceled_at,expires_at);
CREATE INDEX zip_manifests_root ON zip_manifests(root_node_id);
