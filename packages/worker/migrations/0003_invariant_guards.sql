-- These guards defend structural invariants, not caller authorization.
CREATE TRIGGER users_last_admin_update BEFORE UPDATE OF role,disabled_at ON users
WHEN OLD.role='app_admin' AND OLD.disabled_at IS NULL AND (NEW.role<>'app_admin' OR NEW.disabled_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND role='app_admin' AND disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
CREATE TRIGGER users_last_admin_delete BEFORE DELETE ON users
WHEN OLD.role='app_admin' AND OLD.disabled_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND role='app_admin' AND disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
CREATE TRIGGER sessions_identity_update BEFORE UPDATE OF id,user_id,kind,fingerprint,epoch,issued_at ON sessions
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.kind<>OLD.kind OR NEW.fingerprint<>OLD.fingerprint
 OR NEW.epoch<>OLD.epoch OR NEW.issued_at<>OLD.issued_at
BEGIN SELECT RAISE(ABORT,'immutable_session_identity'); END;
CREATE TRIGGER sessions_no_unrevoke BEFORE UPDATE OF revoked_at ON sessions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'revoked_session'); END;
CREATE TRIGGER credentials_immutable BEFORE UPDATE ON credentials
BEGIN SELECT RAISE(ABORT,'immutable_credential'); END;
-- Purge may detach a revoked scope root while retaining credential/operation tombstones.
CREATE TRIGGER app_passwords_scope_detach BEFORE UPDATE OF root_node_id ON app_passwords
WHEN OLD.root_node_id IS NOT NULL AND NEW.root_node_id IS NOT OLD.root_node_id AND NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'revoke_before_scope_detach'); END;
CREATE TRIGGER app_passwords_no_unrevoke BEFORE UPDATE OF revoked_at ON app_passwords
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'revoked_credential'); END;
CREATE TRIGGER nodes_space_insert BEFORE INSERT ON nodes
WHEN NOT EXISTS(SELECT 1 FROM spaces s WHERE s.id=NEW.space_id AND s.owner_id=NEW.owner_id
  AND ((NEW.kind='root' AND s.root_node_id=NEW.id) OR (NEW.kind<>'root' AND s.root_node_id<>NEW.id)))
BEGIN SELECT RAISE(ABORT,'invalid_space_root'); END;
CREATE TRIGGER nodes_identity_update BEFORE UPDATE OF id,owner_id,space_id,kind ON nodes
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.space_id<>OLD.space_id OR NEW.kind<>OLD.kind
BEGIN SELECT RAISE(ABORT,'immutable_node_identity'); END;
CREATE TRIGGER nodes_root_update BEFORE UPDATE ON nodes
WHEN OLD.kind='root' AND (NEW.name<>OLD.name OR NEW.name_ci<>OLD.name_ci OR NEW.parent_id IS NOT NULL OR NEW.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'immutable_root'); END;
CREATE TRIGGER nodes_root_delete BEFORE DELETE ON nodes WHEN OLD.kind='root'
BEGIN SELECT RAISE(ABORT,'immutable_root'); END;
CREATE TRIGGER spaces_identity_update BEFORE UPDATE OF id,owner_id,root_node_id ON spaces
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.root_node_id<>OLD.root_node_id
BEGIN SELECT RAISE(ABORT,'immutable_space_identity'); END;
CREATE TRIGGER nodes_parent_insert BEFORE INSERT ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id AND p.owner_id=NEW.owner_id
  AND p.kind IN ('root','folder') AND (NEW.deleted_at IS NOT NULL OR p.deleted_at IS NULL))
BEGIN SELECT RAISE(ABORT,'invalid_parent'); END;
CREATE TRIGGER nodes_parent_update BEFORE UPDATE OF parent_id,deleted_at ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id AND p.owner_id=NEW.owner_id
  AND p.kind IN ('root','folder') AND (NEW.deleted_at IS NOT NULL OR p.deleted_at IS NULL))
BEGIN SELECT RAISE(ABORT,'invalid_parent'); END;
CREATE TRIGGER nodes_depth_insert BEFORE INSERT ON nodes WHEN NEW.parent_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    WITH RECURSIVE a(id,parent_id,kind,deleted_at,depth) AS (
      SELECT id,parent_id,kind,deleted_at,1 FROM nodes WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,p.kind,p.deleted_at,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<65
    ) SELECT MAX(depth) FROM a HAVING MAX(depth)<=64 AND MIN(deleted_at IS NULL)=1 AND SUM(kind='root')=1
  ) THEN RAISE(ABORT,'invalid_tree_depth') END;
END;
CREATE TRIGGER nodes_tree_update BEFORE UPDATE OF parent_id,deleted_at ON nodes
WHEN NEW.kind<>'root' AND NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    WITH RECURSIVE a(id,parent_id,kind,deleted_at,depth) AS (
      SELECT id,parent_id,kind,deleted_at,1 FROM nodes WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,p.kind,p.deleted_at,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<65
    ), d(id,depth) AS (
      SELECT OLD.id,0 UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id WHERE d.depth<65 AND n.deleted_at IS NULL
    ) SELECT MAX(depth) FROM a HAVING MIN(deleted_at IS NULL)=1 AND SUM(kind='root')=1 AND SUM(id=OLD.id)=0
      AND MAX(depth)+(SELECT MAX(depth) FROM d)<=64
  ) THEN RAISE(ABORT,'invalid_tree_cycle_or_depth') END;
END;
CREATE TRIGGER nodes_blob_insert BEFORE INSERT ON nodes WHEN NEW.current_blob_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.current_blob_id AND owner_id=NEW.owner_id AND state NOT IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'blob_unrecoverable'); END;
CREATE TRIGGER nodes_blob_update BEFORE UPDATE OF current_blob_id,deleted_at ON nodes WHEN NEW.current_blob_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.current_blob_id AND owner_id=NEW.owner_id AND state NOT IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'blob_unrecoverable'); END;
CREATE TRIGGER versions_blob_insert BEFORE INSERT ON node_versions
WHEN NOT EXISTS(SELECT 1 FROM blobs b JOIN nodes n ON n.id=NEW.node_id
 WHERE b.id=NEW.blob_id AND b.owner_id=n.owner_id AND b.state NOT IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'blob_unrecoverable'); END;
CREATE TRIGGER versions_immutable BEFORE UPDATE ON node_versions
BEGIN SELECT RAISE(ABORT,'immutable_version'); END;
CREATE TRIGGER pins_blob_insert BEFORE INSERT ON blob_pins
WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state NOT IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'blob_unrecoverable'); END;
CREATE TRIGGER pins_blob_update BEFORE UPDATE OF blob_id ON blob_pins
WHEN NEW.blob_id<>OLD.blob_id BEGIN SELECT RAISE(ABORT,'immutable_pin_blob'); END;
CREATE TRIGGER blobs_immutable BEFORE UPDATE OF id,owner_id,r2_key,size ON blobs
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.r2_key<>OLD.r2_key OR NEW.size<>OLD.size
BEGIN SELECT RAISE(ABORT,'immutable_blob'); END;
CREATE TRIGGER blobs_deleting_irreversible BEFORE UPDATE OF state ON blobs
WHEN (OLD.state='deleting' AND NEW.state NOT IN ('deleting','deleted')) OR (OLD.state='deleted' AND NEW.state<>'deleted')
BEGIN SELECT RAISE(ABORT,'blob_unrecoverable'); END;
CREATE TRIGGER blobs_delete_ref_guard BEFORE UPDATE OF state ON blobs WHEN NEW.state IN ('deleting','deleted')
 AND (NEW.ref_count<>0 OR EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=NEW.id)
  OR EXISTS(SELECT 1 FROM node_versions WHERE blob_id=NEW.id) OR EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=NEW.id))
BEGIN SELECT RAISE(ABORT,'blob_referenced'); END;
CREATE TRIGGER operation_terminal_immutable BEFORE UPDATE ON operations
WHEN OLD.state IN ('committed','failed')
BEGIN SELECT RAISE(ABORT,'terminal_operation'); END;
CREATE TRIGGER permits_no_reopen BEFORE UPDATE OF state ON permits
WHEN OLD.state<>'open' AND NEW.state<>OLD.state
BEGIN SELECT RAISE(ABORT,'terminal_permit'); END;
CREATE TRIGGER outbox_no_reopen BEFORE UPDATE OF state ON outbox
WHEN OLD.state='completed' AND NEW.state<>'completed'
BEGIN SELECT RAISE(ABORT,'terminal_outbox'); END;
CREATE TRIGGER single_upload_transition BEFORE UPDATE OF state ON uploads
WHEN OLD.mode='single' AND NEW.state<>OLD.state AND NOT (
 (OLD.state='created' AND NEW.state IN ('receiving','aborted','expired')) OR
 (OLD.state='receiving' AND NEW.state IN ('completing','aborted','expired')) OR
 (OLD.state='completing' AND NEW.state IN ('completed','failed')))
BEGIN SELECT RAISE(ABORT,'invalid_upload_transition'); END;
CREATE TRIGGER uploads_identity_update BEFORE UPDATE OF mode,blob_id,declared_size,credential_id,reservation_id ON uploads
WHEN NEW.mode<>OLD.mode OR NEW.blob_id<>OLD.blob_id OR NEW.declared_size<>OLD.declared_size
 OR NEW.credential_id<>OLD.credential_id OR NEW.reservation_id<>OLD.reservation_id
BEGIN SELECT RAISE(ABORT,'immutable_upload_identity'); END;
