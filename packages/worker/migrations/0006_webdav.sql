ALTER TABLE app_passwords ADD COLUMN label TEXT NOT NULL DEFAULT '' CHECK(length(label) BETWEEN 0 AND 64);
ALTER TABLE app_passwords ADD COLUMN last_used_at INTEGER;
ALTER TABLE locks ADD COLUMN display_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE locks ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1);
ALTER TABLE locks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX node_props_node ON node_props(node_id,namespace_uri,local_name);
