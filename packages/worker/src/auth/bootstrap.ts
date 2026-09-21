import type { Env } from "../env.js";

export interface BootstrapIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export interface BootstrapInput {
  identity: BootstrapIdentity;
  allowedEmails: readonly string[];
  allowedIdentities: readonly string[];
  userId: string;
  spaceId: string;
  rootNodeId: string;
}

export function isBootstrapIdentityAllowed(input: BootstrapInput): boolean {
  const email = input.identity.email.toLowerCase();
  return (
    input.allowedEmails.some((candidate) => candidate.toLowerCase() === email) ||
    input.allowedIdentities.includes(`${input.identity.issuer}|${input.identity.subject}`)
  );
}

export async function bootstrapOwner(
  env: Env,
  input: BootstrapInput,
  now = Date.now(),
): Promise<void> {
  if (!isBootstrapIdentityAllowed(input)) {
    throw new Error("bootstrap_identity_denied");
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND bootstrap_done_at IS NULL)",
    ),
    env.DB.prepare(
      "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,used_bytes,physical_bytes,reserved_bytes,disabled_at,created_at) VALUES(?1,?2,?3,?4,'app_admin',0,0,0,0,NULL,?5)",
    ).bind(input.userId, input.identity.issuer, input.identity.subject, input.identity.email, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES(?1,?2,?3,1)",
    ).bind(input.spaceId, input.userId, input.rootNodeId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,hidden) VALUES(?1,?2,?3,NULL,'','', 'root',NULL,1,?4,?4,NULL,0)",
    ).bind(input.rootNodeId, input.spaceId, input.userId, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE control SET bootstrap_done_at=?1,bootstrap_iss=?2,bootstrap_sub=?3,updated_at=?1 WHERE singleton=1 AND bootstrap_done_at IS NULL",
    ).bind(now, input.identity.issuer, input.identity.subject),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

export async function disableUser(env: Env, userId: string, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET disabled_at=?1 WHERE id=?2 AND disabled_at IS NULL AND (role<>'app_admin' OR EXISTS(SELECT 1 FROM users other WHERE other.id<>?2 AND other.role='app_admin' AND other.disabled_at IS NULL))",
    ).bind(now, userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE shares SET disabled_at=?1 WHERE owner_id=?2 AND disabled_at IS NULL",
    ).bind(now, userId),
  ]);
}
