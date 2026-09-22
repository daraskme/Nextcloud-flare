CREATE TABLE purge_members(
  purge_op_id TEXT NOT NULL REFERENCES operations(op_id),
  node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 64),
  PRIMARY KEY(purge_op_id,node_id)
) STRICT;
CREATE INDEX purge_members_operation_depth ON purge_members(purge_op_id,depth DESC,node_id);

CREATE TABLE purge_blobs(
  purge_op_id TEXT NOT NULL REFERENCES operations(op_id),
  blob_id TEXT NOT NULL,
  PRIMARY KEY(purge_op_id,blob_id)
) STRICT;
