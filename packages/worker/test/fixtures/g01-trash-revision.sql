UPDATE nodes SET deleted_at=1000,last_op_id='op-trash' WHERE id='node' AND revision=4 AND deleted_at IS NULL;
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
UPDATE trash_ops SET state='trashed' WHERE op_id='trash' AND state='pending';
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space' AND tree_generation=7;
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
