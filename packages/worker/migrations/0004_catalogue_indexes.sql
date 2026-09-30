-- Generated from the migration FK graph and shared operation contract.
INSERT INTO operation_kinds(name) VALUES
('account.logout'),
('account.read'),
('admin.dlq'),
('admin.lock.force_unlock'),
('admin.repair'),
('admin.transfer'),
('admin.user.disable'),
('audio.metadata.write'),
('audio.read'),
('automation.list'),
('automation.metadata.read'),
('content.read'),
('content.session.accept'),
('content.session.create'),
('credential.create'),
('credential.read'),
('credential.revoke'),
('csrf.issue'),
('dav.copy'),
('dav.delete'),
('dav.lock'),
('dav.mkcol'),
('dav.move'),
('dav.options'),
('dav.propfind'),
('dav.proppatch'),
('dav.put'),
('dav.read'),
('dav.unlock'),
('gallery.read'),
('job.cancel'),
('job.read'),
('job.retry'),
('library.read'),
('library.write'),
('node.content.write'),
('node.copy'),
('node.create'),
('node.move'),
('node.purge'),
('node.read'),
('node.rename'),
('node.restore'),
('node.star'),
('node.trash'),
('operation.read'),
('playback_state.write'),
('public.asset.read'),
('reader.shell'),
('reading_state.write'),
('recent.read'),
('search.read'),
('share.disable'),
('share.landing'),
('share.logout'),
('share.manage'),
('share.read'),
('share.unlock'),
('shared.read'),
('spa.read'),
('starred.read'),
('system.backup'),
('system.gc'),
('system.repair'),
('tag.create'),
('tag.delete'),
('tag.read'),
('tag.update'),
('ticket.cancel'),
('trash.read'),
('upload.abort'),
('upload.complete'),
('upload.create'),
('upload.read'),
('upload.write'),
('zip.create'),
('zip.read');
CREATE INDEX activity_kind_fk ON activity(kind);
CREATE INDEX activity_actor_id_fk ON activity(actor_id);
CREATE INDEX activity_op_id_fk ON activity(op_id);
CREATE INDEX app_passwords_root_node_id_fk ON app_passwords(root_node_id);
CREATE INDEX app_passwords_user_id_fk ON app_passwords(user_id);
CREATE INDEX archive_index_blob_id_fk ON archive_index(blob_id);
CREATE INDEX blob_pins_blob_id_fk ON blob_pins(blob_id);
CREATE INDEX blobs_owner_id_fk ON blobs(owner_id);
CREATE INDEX budgets_unlock_session_id_fk ON budgets(unlock_session_id);
CREATE INDEX budgets_share_id_fk ON budgets(share_id);
CREATE INDEX budgets_user_id_fk ON budgets(user_id);
CREATE INDEX budgets_owner_id_fk ON budgets(owner_id);
CREATE INDEX bulk_jobs_kind_fk ON bulk_jobs(kind);
CREATE INDEX bulk_jobs_op_id_fk ON bulk_jobs(op_id);
CREATE INDEX bulk_jobs_credential_id_fk ON bulk_jobs(credential_id);
CREATE INDEX bulk_jobs_owner_id_fk ON bulk_jobs(owner_id);
CREATE INDEX content_sessions_budget_id_fk ON content_sessions(budget_id);
CREATE INDEX content_sessions_target_set_id_fk ON content_sessions(target_set_id);
CREATE INDEX content_sessions_issued_by_credential_id_fk ON content_sessions(issued_by_credential_id);
CREATE INDEX content_sessions_share_id_fk ON content_sessions(share_id);
CREATE INDEX content_sessions_user_id_fk ON content_sessions(user_id);
CREATE INDEX credential_scopes_scope_fk ON credential_scopes(scope);
CREATE INDEX derivative_results_blob_id_fk ON derivative_results(blob_id);
CREATE INDEX gc_candidates_trash_op_id_fk ON gc_candidates(trash_op_id);
CREATE INDEX library_items_blob_id_fk ON library_items(blob_id);
CREATE INDEX library_roots_node_id_fk ON library_roots(node_id);
CREATE INDEX locks_creator_credential_id_fk ON locks(creator_credential_id);
CREATE INDEX locks_space_id_fk ON locks(space_id);
CREATE INDEX locks_node_id_fk ON locks(node_id);
CREATE INDEX node_audio_blob_id_fk ON node_audio(blob_id);
CREATE INDEX node_media_blob_id_fk ON node_media(blob_id);
CREATE INDEX node_tags_tag_id_fk ON node_tags(tag_id);
CREATE INDEX node_versions_blob_id_fk ON node_versions(blob_id);
CREATE INDEX nodes_deleted_op_id_fk ON nodes(deleted_op_id);
CREATE INDEX nodes_current_blob_id_fk ON nodes(current_blob_id);
CREATE INDEX nodes_owner_id_fk ON nodes(owner_id);
CREATE INDEX nodes_space_id_fk ON nodes(space_id);
CREATE INDEX operations_permit_id_fk ON operations(permit_id);
CREATE INDEX operations_kind_fk ON operations(kind);
CREATE INDEX operations_space_id_fk ON operations(space_id);
CREATE INDEX operations_credential_id_fk ON operations(credential_id);
CREATE INDEX outbox_op_id_fk ON outbox(op_id);
CREATE INDEX reservations_op_id_fk ON reservations(op_id);
CREATE INDEX reservations_share_id_fk ON reservations(share_id);
CREATE INDEX reservations_owner_id_fk ON reservations(owner_id);
CREATE INDEX service_principals_root_node_id_fk ON service_principals(root_node_id);
CREATE INDEX service_principals_space_id_fk ON service_principals(space_id);
CREATE INDEX service_principals_mapped_user_id_fk ON service_principals(mapped_user_id);
CREATE INDEX sessions_user_id_fk ON sessions(user_id);
CREATE INDEX share_grants_user_id_fk ON share_grants(user_id);
CREATE INDEX share_sessions_user_id_fk ON share_sessions(user_id);
CREATE INDEX share_sessions_share_id_fk ON share_sessions(share_id);
CREATE INDEX shares_root_node_id_fk ON shares(root_node_id);
CREATE INDEX shares_owner_id_fk ON shares(owner_id);
CREATE INDEX stars_node_id_fk ON stars(node_id);
CREATE INDEX target_sets_credential_id_fk ON target_sets(credential_id);
CREATE INDEX target_sets_owner_id_fk ON target_sets(owner_id);
CREATE INDEX tickets_budget_id_fk ON tickets(budget_id);
CREATE INDEX tickets_target_set_id_fk ON tickets(target_set_id);
CREATE INDEX tickets_credential_id_fk ON tickets(credential_id);
CREATE INDEX trash_members_node_id_fk ON trash_members(node_id);
CREATE INDEX trash_ops_space_id_fk ON trash_ops(space_id);
CREATE INDEX trash_ops_actor_id_fk ON trash_ops(actor_id);
CREATE INDEX uploads_credential_id_fk ON uploads(credential_id);
CREATE INDEX uploads_target_id_fk ON uploads(target_id);
CREATE INDEX uploads_parent_id_fk ON uploads(parent_id);
CREATE INDEX uploads_space_id_fk ON uploads(space_id);
CREATE INDEX uploads_owner_id_fk ON uploads(owner_id);
CREATE INDEX user_playback_state_blob_id_fk ON user_playback_state(blob_id);
CREATE INDEX user_playback_state_node_id_fk ON user_playback_state(node_id);
CREATE INDEX user_reading_state_blob_id_fk ON user_reading_state(blob_id);
CREATE INDEX user_reading_state_node_id_fk ON user_reading_state(node_id);
