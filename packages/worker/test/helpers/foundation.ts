import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

export async function applyFoundationMigration(): Promise<void> {
  const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
}

export async function seedFoundation(now = Date.now()): Promise<void> {
  await applyFoundationMigration();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_parts"),
    env.DB.prepare("DELETE FROM archive_index"),
    env.DB.prepare("DELETE FROM user_reading_state"),
    env.DB.prepare("DELETE FROM user_playback_state"),
    env.DB.prepare("DELETE FROM node_tags"),
    env.DB.prepare("DELETE FROM node_media"),
    env.DB.prepare("DELETE FROM node_audio"),
    env.DB.prepare("DELETE FROM library_items"),
    env.DB.prepare("DELETE FROM node_props"),
    env.DB.prepare("DELETE FROM share_grants"),
    env.DB.prepare("DELETE FROM share_sessions"),
    env.DB.prepare("DELETE FROM content_sessions"),
    env.DB.prepare("DELETE FROM content_target_sets"),
    env.DB.prepare("DELETE FROM locks"),
    env.DB.prepare("DELETE FROM uploads"),
    env.DB.prepare("DELETE FROM node_versions"),
    env.DB.prepare("DELETE FROM bulk_jobs"),
    env.DB.prepare("DELETE FROM blob_pins"),
    env.DB.prepare("DELETE FROM gc_candidates"),
    env.DB.prepare("DELETE FROM derivative_results"),
    env.DB.prepare("DELETE FROM job_leases"),
    env.DB.prepare("DELETE FROM backup_runs"),
    env.DB.prepare("DELETE FROM recovery_runs"),
    env.DB.prepare("DELETE FROM trash_members"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM audit"),
    env.DB.prepare("DELETE FROM operation_steps"),
    env.DB.prepare("DELETE FROM operations"),
    env.DB.prepare("DELETE FROM permits"),
    env.DB.prepare("DELETE FROM shares"),
    env.DB.prepare("DELETE FROM search_index"),
    env.DB.prepare("DELETE FROM nodes"),
    env.DB.prepare("DELETE FROM trash_ops"),
    env.DB.prepare("DELETE FROM tags"),
    env.DB.prepare("DELETE FROM app_passwords"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM spaces"),
    env.DB.prepare("DELETE FROM blobs"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare(
      "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,used_bytes,physical_bytes,reserved_bytes,disabled_at,created_at) VALUES('user','iss','sub','user@test.invalid','member',1000000,0,0,0,NULL,?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES('space','user','root',1)",
    ),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('root','space','user',NULL,'','', 'root',NULL,1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES('session','user','access','fingerprint',?1,?2,NULL,?1)",
    ).bind(now, now + 86_400_000),
  ]);
}

export async function seedClaimedOperation(
  permitState: "open" | "released" | "revoked" = "open",
  expiresAt = Date.now() + 30_000,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','space',1,?1,?2)",
    ).bind(expiresAt, permitState),
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES('operation','user','user','as:session',NULL,'space','node.create','claimed','digest',1,'permit',?1,?1,5,NULL,NULL,?2,?2)",
    ).bind(expiresAt, now),
  ]);
}

export const createFolderInput = {
  operationId: "operation",
  permitId: "permit",
  epoch: 1,
  userId: "user",
  sessionId: "session",
  spaceId: "space",
  parentId: "root",
  nodeId: "folder",
  name: "Folder",
  expectedParentRevision: 1,
  expectedTreeGeneration: 1,
  outboxId: "outbox",
  auditId: "audit",
} as const;
