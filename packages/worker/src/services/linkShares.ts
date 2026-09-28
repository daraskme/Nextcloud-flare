import { linkShareInput } from "@next-cloud-flare/shared/linkShares";
import { authorizationAssertion } from "../auth/authorize";
import type { AccessSession } from "../auth/sessions";
import {
  hashSharePassword,
  newShareSecret,
  type SharePasswordRecord,
  type SharePasswordRing,
  shareSecretDigest,
} from "../auth/shareSecrets";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";
import { ownRoot, revokeShareSessions, shareAccess } from "./internalShares";

const CLOCK = "strftime('%s','now')*1000";
function actions(id: string, role: "read" | "edit"): SqlStatement[] {
  return [
    { sql: "DELETE FROM share_actions WHERE share_id=?", values: [id] },
    ...(role === "read"
      ? ["read", "download"]
      : ["read", "download", "create", "edit", "upload"]
    ).map((action) => ({
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,?)",
      values: [id, action],
    })),
  ];
}
const passwordValues = (record: SharePasswordRecord | null) => [
  record?.passwordDigest ?? null,
  record?.salt ?? null,
  record?.kdf ?? null,
  record?.kdfParams ?? null,
  record?.kid ?? null,
];
async function password(
  id: string,
  value: string | null | undefined,
  ring?: SharePasswordRing,
  signal?: AbortSignal,
) {
  if (value == null) return null;
  if (!ring) throw new Error("share_password_unavailable");
  return hashSharePassword(id, value, ring, signal);
}

/** Return the random fragment capability once. The database never stores the original. */
export async function createLinkShare(
  env: AccountMutationEnv,
  session: AccessSession,
  value: unknown,
  ring?: SharePasswordRing,
  signal?: AbortSignal,
) {
  const input = linkShareInput(value);
  await atomicBatch(env.DB, shareAccess(session));
  const proof = await ownRoot(env.DB, session, input.rootNodeId);
  const id = `sh_${crypto.randomUUID().replaceAll("-", "")}`,
    secret = newShareSecret(),
    digest = await shareSecretDigest(id, secret),
    savedPassword = await password(id, input.password, ring, signal);
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "share.create",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...shareAccess(session),
    authorizationAssertion(proof),
    assertExists(`SELECT 1 WHERE ? IS NULL OR ?>${CLOCK}`, [input.expiresAt, input.expiresAt]),
    {
      sql: `INSERT INTO shares(id,owner_id,root_node_id,kind,version,secret_digest,password_digest,salt,kdf,kdf_params,kid,expires_at,created_at)
      VALUES(?,?,?,'link',1,?,?,?,?,?,?,?,${CLOCK})`,
      values: [
        id,
        session.user_id,
        input.rootNodeId,
        digest,
        ...passwordValues(savedPassword),
        input.expiresAt,
      ],
    },
    assertOneChange,
    ...actions(id, input.role),
  ]);
  return { id, version: 1, secret };
}
export async function updateLinkShare(
  env: AccountMutationEnv,
  session: AccessSession,
  id: string,
  version: number,
  value: unknown | null,
  ring?: SharePasswordRing,
  signal?: AbortSignal,
) {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("invalid_share_request");
  const input = value === null ? null : linkShareInput(value, true);
  await atomicBatch(env.DB, shareAccess(session));
  const saved = await primary(env.DB)
    .prepare(`SELECT root_node_id AS root,version,secret_digest,
    password_digest AS passwordDigest,salt,kdf,kdf_params AS kdfParams,kid FROM shares
    WHERE id=? AND owner_id=? AND kind='link' AND disabled_at IS NULL`)
    .bind(id, session.user_id)
    .first<{ root: string; version: number; secret_digest: string } & SharePasswordRecord>();
  if (!saved) throw new Error("share_unavailable");
  if (saved.version !== version) throw new Error("share_version_conflict");
  if (input && input.rootNodeId !== saved.root) throw new Error("invalid_share_request");
  const proof = await ownRoot(env.DB, session, saved.root);
  const secret = input?.rotateSecret ? newShareSecret() : undefined;
  const digest = secret ? await shareSecretDigest(id, secret) : saved.secret_digest;
  const nextPassword =
    input && Object.hasOwn(input, "password")
      ? await password(id, input.password, ring, signal)
      : saved.passwordDigest
        ? saved
        : null;
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    input ? "share.update" : "share.disable",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...shareAccess(session),
    authorizationAssertion(proof),
    assertExists(
      `SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind='link' AND root_node_id=? AND version=? AND disabled_at IS NULL
      AND secret_digest IS ? AND password_digest IS ? AND salt IS ? AND kid IS ?`,
      [
        id,
        session.user_id,
        saved.root,
        version,
        saved.secret_digest,
        saved.passwordDigest,
        saved.salt,
        saved.kid,
      ],
    ),
    ...(input
      ? [assertExists(`SELECT 1 WHERE ? IS NULL OR ?>${CLOCK}`, [input.expiresAt, input.expiresAt])]
      : []),
    input
      ? {
          sql: "UPDATE shares SET version=version+1,expires_at=?,secret_digest=?,password_digest=?,salt=?,kdf=?,kdf_params=?,kid=? WHERE id=?",
          values: [input.expiresAt, digest, ...passwordValues(nextPassword), id],
        }
      : {
          sql: `UPDATE shares SET version=version+1,disabled_at=${CLOCK} WHERE id=?`,
          values: [id],
        },
    assertOneChange,
    ...(input ? actions(id, input.role) : []),
    ...revokeShareSessions(id),
  ]);
  return { id, version: version + 1, disabled: input === null, ...(secret ? { secret } : {}) };
}
