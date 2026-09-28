import { validSharePassword } from "@next-cloud-flare/shared/linkShares";
import { base64url } from "jose";
import {
  matchesSharePassword,
  type SharePasswordRecord,
  type SharePasswordRing,
  shareSecretDigest,
} from "../auth/shareSecrets";
import type { ShareCookieClaims, UnlockChallenge } from "../auth/shareTokens";
import { assertExists, primary } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";

const CLOCK = "strftime('%s','now')*1000";
interface ActiveLink {
  id: string;
  owner_id: string;
  root_node_id: string;
  space_id: string;
  version: number;
  secret_digest: string;
  expires_at: number | null;
  password_digest: string | null;
  salt: string | null;
  kdf: "PBKDF2-SHA256" | null;
  kdf_params: string | null;
  kid: string | null;
  can_create: number;
  can_rename: number;
  can_upload: number;
}
export interface ShareSession {
  claims: ShareCookieClaims;
  ownerId: string;
  rootNodeId: string;
  spaceId: string;
  permissions: { createFolder: boolean; rename: boolean; upload: boolean; overwrite: boolean };
}
// Pre-authentication proof: inspect only this share's bounded ancestry, without fabricating a user credential.
const ACTIVE_LINK = `WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
  SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,0,'/'||n.id||'/'
  FROM shares sh JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id WHERE sh.id=?1
  UNION ALL SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.path||n.id||'/'
  FROM a JOIN nodes n ON n.id=a.parent_id AND n.space_id=a.space_id AND n.owner_id=a.owner_id
  WHERE a.depth<64 AND instr(a.path,'/'||n.id||'/')=0
  ) SELECT sh.*,n.space_id,
  EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='create') AS can_create,
  EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='edit') AS can_rename,
  EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='upload') AS can_upload
  FROM shares sh JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
  JOIN users owner ON owner.id=sh.owner_id JOIN control ctl ON ctl.singleton=1
  WHERE sh.id=?1 AND sh.kind='link' AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
  AND ctl.epoch=?2 AND ctl.maintenance=0 AND (sh.expires_at IS NULL OR sh.expires_at>${CLOCK})
  AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='read')
  AND EXISTS(SELECT COUNT(*) FROM a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=a.owner_id
  HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1 AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1)`;

async function binding(claims: UnlockChallenge) {
  const hash = async (purpose: string) =>
    base64url.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([purpose, claims.share_id, claims.epoch, claims.nonce]),
          ),
        ),
      ),
    );
  return {
    id: `us_${await hash("ncf-share-session-id-v1")}`,
    digest: await hash("ncf-share-session-secret-v1"),
  };
}
async function sessionQuery(claims: ShareCookieClaims) {
  const bound = await binding(claims);
  if (bound.id !== claims.session_id) throw new Error("share_session_unavailable");
  return {
    sql: `${ACTIVE_LINK} AND sh.version=?3 AND EXISTS(SELECT 1 FROM share_sessions ss JOIN credentials c ON c.share_session_id=ss.id AND c.kind='share'
    WHERE ss.id=?4 AND ss.share_id=sh.id AND ss.share_version=sh.version AND ss.epoch=ctl.epoch
    AND ss.user_id IS NULL AND ss.secret_digest=?5 AND ss.revoked_at IS NULL AND ss.issued_at=?6 AND ss.expires_at=?7 AND ss.expires_at>${CLOCK})`,
    values: [
      claims.share_id,
      claims.epoch,
      claims.share_version,
      bound.id,
      bound.digest,
      claims.iat * 1000,
      claims.exp * 1000,
    ],
  };
}
export async function readShareSession(
  db: D1Database,
  claims: ShareCookieClaims,
): Promise<ShareSession> {
  const query = await sessionQuery(claims);
  const row = await primary(db)
    .prepare(query.sql)
    .bind(...query.values)
    .first<ActiveLink>();
  if (!row) throw new Error("share_session_unavailable");
  return {
    claims,
    ownerId: row.owner_id,
    rootNodeId: row.root_node_id,
    spaceId: row.space_id,
    permissions: {
      createFolder: row.can_create === 1,
      rename: row.can_rename === 1,
      upload: row.can_upload === 1 && row.can_create === 1,
      overwrite: row.can_upload === 1 && row.can_rename === 1,
    },
  };
}

/** The signed challenge supplies a stable identity across concurrent submission and lost replies. */
export async function unlockShare(
  env: AccountMutationEnv,
  challenge: UnlockChallenge,
  value: unknown,
  passwords?: SharePasswordRing,
  signal?: AbortSignal,
): Promise<ShareSession> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_request");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((k) => !["secret", "password"].includes(k)) ||
    typeof input.secret !== "string" ||
    (input.password !== undefined && !validSharePassword(input.password))
  )
    throw new Error("invalid_share_request");
  if (challenge.exp * 1000 <= Date.now() || challenge.iat * 1000 > Date.now())
    throw new Error("share_unlock_rejected");
  const row = await primary(env.DB)
    .prepare(ACTIVE_LINK)
    .bind(challenge.share_id, challenge.epoch)
    .first<ActiveLink>();
  if (!row) throw new Error("share_unlock_rejected");
  let digest: string;
  try {
    digest = await shareSecretDigest(row.id, input.secret);
  } catch {
    throw new Error("share_unlock_rejected");
  }
  if (digest !== row.secret_digest) throw new Error("share_unlock_rejected");
  if (row.password_digest !== null) {
    if (!passwords) throw new Error("share_password_unavailable");
    const saved: SharePasswordRecord = {
      passwordDigest: row.password_digest,
      salt: row.salt!,
      kdf: row.kdf!,
      kdfParams: row.kdf_params!,
      kid: row.kid!,
    };
    if (
      typeof input.password !== "string" ||
      !(await matchesSharePassword(row.id, input.password, saved, passwords, signal))
    )
      throw new Error("share_unlock_rejected");
  }
  signal?.throwIfAborted();
  const identity = await binding(challenge);
  const claims: ShareCookieClaims = {
    ...challenge,
    session_id: identity.id,
    share_version: row.version,
    exp: Math.floor(
      Math.min((challenge.iat + 604800) * 1000, row.expires_at ?? Number.MAX_SAFE_INTEGER) / 1000,
    ),
  };
  const query = await sessionQuery(claims);
  // A used challenge cannot resurrect a revoked/expired session or create a replacement budget.
  if (
    await primary(env.DB)
      .prepare("SELECT 1 FROM share_sessions WHERE id=?")
      .bind(identity.id)
      .first()
  )
    return readShareSession(env.DB, claims);
  const admission = await acquireAccountMutation(
    env,
    row.owner_id,
    challenge.epoch,
    "session.register",
  );
  await commitAccountMutation(env.DB, admission, row.owner_id, [
    assertExists(
      `${ACTIVE_LINK} AND sh.owner_id=?3 AND sh.root_node_id=?4 AND sh.version=?5 AND sh.secret_digest=?6
      AND sh.password_digest IS ?7 AND sh.salt IS ?8 AND sh.kdf IS ?9 AND sh.kdf_params IS ?10 AND sh.kid IS ?11 AND sh.expires_at IS ?12`,
      [
        row.id,
        challenge.epoch,
        row.owner_id,
        row.root_node_id,
        row.version,
        digest,
        row.password_digest,
        row.salt,
        row.kdf,
        row.kdf_params,
        row.kid,
        row.expires_at,
      ],
    ),
    assertExists(`SELECT 1 WHERE ?>${CLOCK} AND ?>${CLOCK}`, [
      challenge.exp * 1000,
      claims.exp * 1000,
    ]),
    {
      sql: "INSERT INTO share_sessions(id,share_id,share_version,user_id,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,?,NULL,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      values: [
        identity.id,
        row.id,
        row.version,
        identity.digest,
        challenge.epoch,
        claims.iat * 1000,
        claims.exp * 1000,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?) ON CONFLICT(id) DO NOTHING",
      values: [`ss:${identity.id}`, identity.id],
    },
    assertExists(query.sql, query.values),
  ]);
  return readShareSession(env.DB, claims);
}

export async function logoutShare(env: AccountMutationEnv, session: ShareSession): Promise<void> {
  const current = await readShareSession(env.DB, session.claims);
  const query = await sessionQuery(current.claims),
    credential = `ss:${current.claims.session_id}`;
  const admission = await acquireAccountMutation(
    env,
    current.ownerId,
    current.claims.epoch,
    "session.revoke",
  );
  await commitAccountMutation(env.DB, admission, current.ownerId, [
    assertExists(query.sql, query.values),
    {
      sql: `UPDATE share_sessions SET revoked_at=COALESCE(revoked_at,${CLOCK}) WHERE id=?`,
      values: [current.claims.session_id],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${CLOCK}) WHERE issued_by_credential_id=?`,
      values: [credential],
    },
    {
      sql: `UPDATE tickets SET cancelled_at=COALESCE(cancelled_at,${CLOCK}) WHERE credential_id=?`,
      values: [credential],
    },
  ]);
}
