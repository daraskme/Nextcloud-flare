import { linkShareInput } from "@next-cloud-flare/shared/linkShares";
import { uploadOnlyShareInput } from "@next-cloud-flare/shared/uploadOnlyShares";
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
function actions(id: string, role: "read" | "edit" | "upload_only"): SqlStatement[] {
  return [
    { sql: "DELETE FROM share_actions WHERE share_id=?", values: [id] },
    ...(role === "upload_only"
      ? ["create", "upload"]
      : role === "read"
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
const publicInput = (value: unknown, updating = false) =>
  value && typeof value === "object" && (value as { kind?: unknown }).kind === "upload_only"
    ? uploadOnlyShareInput(value, updating)
    : linkShareInput(value, updating);
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
  const input = publicInput(value);
  await atomicBatch(env.DB, shareAccess(session));
  const proof = await ownRoot(env.DB, session, input.rootNodeId);
  if (input.kind === "upload_only" && proof.node.kind === "file")
    throw new Error("invalid_share_request");
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
      sql: `INSERT INTO shares(id,owner_id,root_node_id,kind,version,secret_digest,password_digest,salt,kdf,kdf_params,kid,expires_at,reservation_limit,created_at)
      VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,${CLOCK})`,
      values: [
        id,
        session.user_id,
        input.rootNodeId,
        input.kind,
        digest,
        ...passwordValues(savedPassword),
        input.expiresAt,
        input.kind === "upload_only" ? input.reservationLimit : 0,
      ],
    },
    assertOneChange,
    ...actions(id, input.kind === "upload_only" ? "upload_only" : input.role),
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
  const input = value === null ? null : publicInput(value, true);
  await atomicBatch(env.DB, shareAccess(session));
  const saved = await primary(env.DB)
    .prepare(`SELECT kind,root_node_id AS root,version,secret_digest,reservation_limit,
    password_digest AS passwordDigest,salt,kdf,kdf_params AS kdfParams,kid FROM shares
    WHERE id=? AND owner_id=? AND kind IN ('link','upload_only') AND disabled_at IS NULL`)
    .bind(id, session.user_id)
    .first<
      {
        kind: "link" | "upload_only";
        root: string;
        version: number;
        secret_digest: string;
        reservation_limit: number;
      } & SharePasswordRecord
    >();
  if (!saved) throw new Error("share_unavailable");
  if (saved.version !== version) throw new Error("share_version_conflict");
  if (input && (input.kind !== saved.kind || input.rootNodeId !== saved.root))
    throw new Error("invalid_share_request");
  const proof = await ownRoot(env.DB, session, saved.root);
  if (saved.kind === "upload_only" && proof.node.kind === "file")
    throw new Error("share_unavailable");
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
      `SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind=? AND root_node_id=? AND version=? AND disabled_at IS NULL
      AND secret_digest IS ? AND password_digest IS ? AND salt IS ? AND kid IS ? AND reservation_limit=?`,
      [
        id,
        session.user_id,
        saved.kind,
        saved.root,
        version,
        saved.secret_digest,
        saved.passwordDigest,
        saved.salt,
        saved.kid,
        saved.reservation_limit,
      ],
    ),
    ...(input
      ? [assertExists(`SELECT 1 WHERE ? IS NULL OR ?>${CLOCK}`, [input.expiresAt, input.expiresAt])]
      : []),
    input
      ? {
          sql: "UPDATE shares SET version=version+1,expires_at=?,secret_digest=?,password_digest=?,salt=?,kdf=?,kdf_params=?,kid=?,reservation_limit=? WHERE id=?",
          values: [
            input.expiresAt,
            digest,
            ...passwordValues(nextPassword),
            input.kind === "upload_only" ? input.reservationLimit : saved.reservation_limit,
            id,
          ],
        }
      : {
          sql: `UPDATE shares SET version=version+1,disabled_at=${CLOCK} WHERE id=?`,
          values: [id],
        },
    assertOneChange,
    ...(input ? actions(id, input.kind === "upload_only" ? "upload_only" : input.role) : []),
    ...revokeShareSessions(id),
  ]);
  return { id, version: version + 1, disabled: input === null, ...(secret ? { secret } : {}) };
}
