import { assertExists, assertOneChange, primary } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
} from "../services/accountMutation";
import type { VerifiedAccessUser } from "./access";
import { type AccessSession, assertLiveAccessCredential } from "./sessions";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_QUOTA_BYTES = 1_073_741_824;

export function normalizeInviteEmail(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 320 ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.includes("|") ||
    value.includes(",") ||
    value.split("@").length !== 2 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{}~-]+$/.test(value.split("@")[0] ?? "") ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.split("@")[1] ?? "")
  )
    throw new Error("invalid_invite_email");
  return value;
}

function assertAdmin(session: AccessSession) {
  return [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      `SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
       JOIN users u ON u.id=s.user_id JOIN control ctl ON ctl.singleton=1
       WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.user_id=?
         AND s.epoch=? AND ctl.epoch=? AND ctl.maintenance=0
         AND s.revoked_at IS NULL AND s.expires_at>strftime('%s','now')*1000
         AND u.role='app_admin' AND u.disabled_at IS NULL`,
      [session.credential_id, session.user_id, session.epoch, session.epoch],
    ),
  ];
}

export async function listAccessInvites(db: D1Database, session: AccessSession) {
  if (session.role !== "app_admin") throw new Error("invite_forbidden");
  const admin = await primary(db)
    .prepare(`SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
      JOIN users u ON u.id=s.user_id JOIN control ctl ON ctl.singleton=1
      WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.user_id=?
        AND s.epoch=? AND ctl.epoch=? AND ctl.maintenance=0 AND s.revoked_at IS NULL
        AND s.expires_at>strftime('%s','now')*1000 AND u.role='app_admin' AND u.disabled_at IS NULL`)
    .bind(session.credential_id, session.user_id, session.epoch, session.epoch)
    .first();
  if (!admin) throw new Error("invite_forbidden");
  return (
    await primary(db)
      .prepare(`SELECT id,email,created_at AS createdAt,expires_at AS expiresAt,
        revoked_at AS revokedAt,claimed_at AS claimedAt,claimed_user_id AS claimedUserId
        FROM access_invites
        WHERE revoked_at IS NULL AND claimed_at IS NULL
          AND expires_at>strftime('%s','now')*1000
        ORDER BY created_at DESC,id DESC LIMIT 200`)
      .all()
  ).results;
}

export async function createAccessInvite(
  env: AccountMutationEnv,
  session: AccessSession,
  rawEmail: unknown,
  issuer: string,
) {
  if (session.role !== "app_admin") throw new Error("invite_forbidden");
  if (!issuer || issuer.length > 2048) throw new Error("invite_forbidden");
  const email = normalizeInviteEmail(rawEmail);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const conflict = await primary(env.DB)
    .prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM users WHERE lower(email)=lower(?))
      OR EXISTS(SELECT 1 FROM access_invites WHERE lower(email)=lower(?) AND revoked_at IS NULL
        AND claimed_at IS NULL AND expires_at>strftime('%s','now')*1000)`)
    .bind(email, email)
    .first();
  if (conflict) throw new Error("invite_conflict");
  const activeCount = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS n FROM access_invites WHERE revoked_at IS NULL
      AND claimed_at IS NULL AND expires_at>strftime('%s','now')*1000`)
    .first<number>("n");
  if (activeCount === null) throw new MutationUnavailableError();
  if (activeCount >= 200) throw new Error("invite_conflict");
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "invite.create",
  );
  try {
    await commitAccountMutation(env.DB, admission, session.user_id, [
      ...assertAdmin(session),
      assertExists("SELECT 1 FROM settings WHERE singleton=1 AND signup_enabled=0"),
      assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower(?))", [
        email,
      ]),
      assertExists(`SELECT 1 WHERE (SELECT COUNT(*) FROM access_invites
        WHERE revoked_at IS NULL AND claimed_at IS NULL
          AND expires_at>strftime('%s','now')*1000)<200`),
      {
        sql: `UPDATE access_invites SET revoked_at=strftime('%s','now')*1000
          WHERE lower(email)=lower(?) AND revoked_at IS NULL AND claimed_at IS NULL
            AND expires_at<=strftime('%s','now')*1000`,
        values: [email],
      },
      {
        sql: `INSERT INTO access_invites(id,access_iss,email,approved_by,created_at,expires_at)
          VALUES(?,?,?,?,?,?)`,
        values: [id, issuer, email, session.user_id, now, expiresAt],
      },
    ]);
  } catch {
    throw new MutationUnavailableError();
  }
  return { id, email, createdAt: now, expiresAt };
}

export async function revokeAccessInvite(
  env: AccountMutationEnv,
  session: AccessSession,
  id: string,
) {
  if (session.role !== "app_admin") throw new Error("invite_forbidden");
  const pending = await primary(env.DB)
    .prepare(
      "SELECT 1 FROM access_invites WHERE id=? AND revoked_at IS NULL AND claimed_at IS NULL",
    )
    .bind(id)
    .first();
  if (!pending) throw new Error("invite_not_found");
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "invite.revoke",
  );
  try {
    await commitAccountMutation(env.DB, admission, session.user_id, [
      ...assertAdmin(session),
      {
        sql: `UPDATE access_invites SET revoked_at=strftime('%s','now')*1000
          WHERE id=? AND revoked_at IS NULL AND claimed_at IS NULL`,
        values: [id],
      },
      assertOneChange,
    ]);
  } catch {
    throw new MutationUnavailableError();
  }
}

/** Only a JWT verified by the private Access verifier may consume an invite. */
export async function claimAccessInvite(
  env: AccountMutationEnv,
  claims: VerifiedAccessUser,
  epoch: number,
): Promise<void> {
  if (claims.kind !== "user" || claims.exp * 1000 <= Date.now())
    throw new Error("credential_inactive");
  let email: string;
  try {
    email = normalizeInviteEmail(claims.email);
  } catch {
    throw new Error("credential_inactive");
  }
  const invite = await primary(env.DB)
    .prepare(`SELECT id,approved_by FROM access_invites WHERE email=? AND access_iss=? AND revoked_at IS NULL
      AND claimed_at IS NULL AND expires_at>strftime('%s','now')*1000`)
    .bind(email, claims.iss)
    .first<{ id: string; approved_by: string }>();
  if (!invite) throw new Error("credential_inactive");
  const admission = await acquireAccountMutation(env, invite.approved_by, epoch, "invite.claim");
  const user = crypto.randomUUID();
  const space = crypto.randomUUID();
  const root = crypto.randomUUID();
  try {
    await commitAccountMutation(env.DB, admission, invite.approved_by, [
      assertExists(
        `SELECT 1 FROM control WHERE singleton=1 AND bootstrap_done_at IS NOT NULL
        AND epoch=? AND maintenance=0 AND ?>strftime('%s','now')*1000`,
        [epoch, claims.exp * 1000],
      ),
      assertExists("SELECT 1 FROM settings WHERE singleton=1 AND signup_enabled=0"),
      assertExists(
        `SELECT 1 FROM access_invites i JOIN users admin ON admin.id=i.approved_by
        WHERE i.id=? AND i.email=? AND i.access_iss=? AND i.approved_by=? AND i.revoked_at IS NULL
          AND i.claimed_at IS NULL AND i.expires_at>strftime('%s','now')*1000
          AND admin.role='app_admin' AND admin.disabled_at IS NULL`,
        [invite.id, email, claims.iss, invite.approved_by],
      ),
      assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM users
        WHERE (access_iss=? AND access_sub=?) OR lower(email)=lower(?))`,
        [claims.iss, claims.sub, email],
      ),
      {
        sql: `INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at)
          VALUES(?,?,?,?,'member',?,strftime('%s','now')*1000)`,
        values: [user, claims.iss, claims.sub, email, MEMBER_QUOTA_BYTES],
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
      {
        sql: `UPDATE access_invites SET claimed_at=strftime('%s','now')*1000,claimed_user_id=?
          WHERE id=? AND email=? AND access_iss=? AND approved_by=? AND revoked_at IS NULL
            AND claimed_at IS NULL AND expires_at>strftime('%s','now')*1000`,
        values: [user, invite.id, email, claims.iss, invite.approved_by],
      },
      assertOneChange,
    ]);
  } catch {
    let state: {
      revoked_at: number | null;
      claimed_at: number | null;
      expires_at: number;
      winner_iss: string | null;
      winner_sub: string | null;
      winner_disabled: number | null;
      admin_role: string | null;
      admin_disabled: number | null;
      collision: number;
    } | null;
    try {
      state = await primary(env.DB)
        .prepare(`SELECT i.revoked_at,i.claimed_at,i.expires_at,
          winner.access_iss AS winner_iss,winner.access_sub AS winner_sub,
          winner.disabled_at AS winner_disabled,admin.role AS admin_role,
          admin.disabled_at AS admin_disabled,
          (SELECT COUNT(*) FROM users u WHERE
            (u.access_iss=? AND u.access_sub=?) OR lower(u.email)=lower(?)) AS collision
          FROM access_invites i LEFT JOIN users winner ON winner.id=i.claimed_user_id
          LEFT JOIN users admin ON admin.id=i.approved_by WHERE i.id=?`)
        .bind(claims.iss, claims.sub, email, invite.id)
        .first();
    } catch {
      throw new MutationUnavailableError();
    }
    if (
      state?.claimed_at !== null &&
      state?.winner_iss === claims.iss &&
      state?.winner_sub === claims.sub &&
      state?.winner_disabled === null
    )
      return;
    if (
      !state ||
      state.revoked_at !== null ||
      state.claimed_at !== null ||
      state.expires_at <= Date.now() ||
      state.admin_role !== "app_admin" ||
      state.admin_disabled !== null ||
      state.collision > 0
    )
      throw new Error("credential_inactive");
    throw new MutationUnavailableError();
  }
}
