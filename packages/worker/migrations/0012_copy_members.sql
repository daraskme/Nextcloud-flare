CREATE TABLE copy_members(
  copy_op_id TEXT NOT NULL REFERENCES operations(op_id),
  source_node_id TEXT NOT NULL REFERENCES nodes(id),
  copied_node_id TEXT NOT NULL UNIQUE CHECK(length(copied_node_id) BETWEEN 1 AND 128),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 64),
  PRIMARY KEY(copy_op_id,source_node_id)
) STRICT;
CREATE INDEX copy_members_source_fk ON copy_members(source_node_id);
