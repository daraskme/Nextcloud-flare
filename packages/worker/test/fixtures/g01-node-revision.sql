UPDATE nodes SET revision=revision+1,last_op_id='op-node' WHERE id='node' AND revision=4;
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space' AND tree_generation=7;
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
UPDATE users SET reserved_bytes=reserved_bytes-10,used_bytes=used_bytes+10 WHERE id='user' AND reserved_bytes>=10;
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
INSERT INTO outbox(outbox_id,op_id,state) VALUES('outbox-node','op-node','pending');
INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1;
