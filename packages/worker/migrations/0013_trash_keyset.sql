CREATE INDEX trash_ops_space_created_keyset
ON trash_ops(space_id,created_at DESC,op_id DESC) WHERE state='trashed';
