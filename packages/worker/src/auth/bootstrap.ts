import {
  assertMutationAdmission,
  commitMutationAdmission,
  hasCommittedMutation,
} from "../db/mutationAdmission";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { CONTROL_NAME } from "../do/controlName";
import { type AccountMutationEnv, MutationUnavailableError } from "../services/accountMutation";
import type { VerifiedAccessUser } from "./access";

export interface BootstrapPolicy {
  readonly ownerEmails: readonly string[];
  readonly ownerIdentities: readonly { iss: string; sub: string }[];
  readonly quotaBytes: number;
}
export interface BootstrapUser {
  id: string;
  space_id: string;
  root_node_id: string;
}

/** Only the verified user token from the private Access application may reach this service. */
export async function bootstrapOwner(
  env: AccountMutationEnv,
  claims: VerifiedAccessUser,
  epoch: number,
  policy: BootstrapPolicy,
): Promise<BootstrapUser> {
  if (
    claims.kind !== "user" ||
    !(
      policy.ownerIdentities.some(
        (identity) => identity.iss === claims.iss && identity.sub === claims.sub,
      ) || policy.ownerEmails.some((email) => email === claims.email)
    ) ||
    !Number.isSafeInteger(policy.quotaBytes) ||
    policy.quotaBytes < 0 ||
    policy.quotaBytes > 7_505_999_378_950_825
  )
    throw new Error("bootstrap_not_allowed");
  const db = env.DB;
  const readResult = () =>
    primary(db)
      .prepare(`SELECT u.id,s.id AS space_id,s.root_node_id
    FROM control c JOIN users u ON u.access_iss=c.bootstrap_iss AND u.access_sub=c.bootstrap_sub
    JOIN spaces s ON s.owner_id=u.id JOIN nodes n ON n.id=s.root_node_id
    WHERE c.singleton=1 AND c.bootstrap_done_at IS NOT NULL AND c.epoch=? AND c.maintenance=0
      AND c.bootstrap_iss=? AND c.bootstrap_sub=? AND u.disabled_at IS NULL
      AND n.kind='root' AND n.parent_id IS NULL AND n.deleted_at IS NULL
      AND ?>strftime('%s','now')*1000`)
      .bind(epoch, claims.iss, claims.sub, claims.exp * 1000)
      .first<BootstrapUser>();

  const existing = await readResult();
  if (existing) return existing;
  if (
    !(await primary(db)
      .prepare(
        "SELECT 1 FROM control WHERE singleton=1 AND bootstrap_done_at IS NULL AND epoch=? AND maintenance=0 AND NOT EXISTS(SELECT 1 FROM users) AND ?>strftime('%s','now')*1000",
      )
      .bind(epoch, claims.exp * 1000)
      .first())
  ) {
    const winner = await readResult();
    if (winner) return winner;
    throw new Error("bootstrap_unavailable");
  }
  let admission;
  try {
    admission = await env.CONTROL.get(
      env.CONTROL.idFromName(CONTROL_NAME),
    ).acquireBootstrapMutation({
      permitId: "bootstrap:" + crypto.randomUUID(),
      epoch,
      deadline: Date.now() + 5000,
    });
  } catch {
    throw new MutationUnavailableError();
  }
  if (admission.space_id !== null) throw new MutationUnavailableError();
  const user = crypto.randomUUID();
  const space = crypto.randomUUID();
  const root = crypto.randomUUID();
  try {
    await atomicBatch(db, [
      assertMutationAdmission(admission),
      {
        sql: `UPDATE control SET bootstrap_done_at=strftime('%s','now')*1000,bootstrap_iss=?,bootstrap_sub=?,updated_at=strftime('%s','now')*1000
          WHERE singleton=1 AND bootstrap_done_at IS NULL AND epoch=? AND maintenance=0 AND NOT EXISTS(SELECT 1 FROM users)
          AND ?>strftime('%s','now')*1000`,
        values: [claims.iss, claims.sub, epoch, claims.exp * 1000],
      },
      assertOneChange,
      {
        sql: `INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at)
          VALUES(?,?,?,?,'app_admin',?,strftime('%s','now')*1000)`,
        values: [user, claims.iss, claims.sub, claims.email, policy.quotaBytes],
      },
      {
        sql: "INSERT INTO spaces(id,owner_id,root_node_id) VALUES(?,?,?)",
        values: [space, user, root],
      },
      {
        sql: `INSERT INTO nodes(id,space_id,owner_id,name,name_ci,kind,created_at,updated_at)
          VALUES(?,?,?,'','','root',strftime('%s','now')*1000,strftime('%s','now')*1000)`,
        values: [root, space, user],
      },
      assertExists("SELECT 1 FROM settings WHERE singleton=1 AND signup_enabled=0"),
      ...commitMutationAdmission(admission),
    ]);
  } catch {
    if (!(await hasCommittedMutation(db, admission))) {
      // Another invocation may have initialized this exact identity. Its success is not our receipt:
      // never close or release this invocation's uncertain admission based on the winning account.
      const winner = await readResult();
      if (winner && winner.id !== user) return winner;
      throw new Error("bootstrap_unavailable");
    }
  }
  const result = await readResult();
  if (!result) throw new Error("bootstrap_unavailable");
  return result;
}
