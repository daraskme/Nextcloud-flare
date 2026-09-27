import { portableName } from "@next-cloud-flare/shared/names";
import { type InternalShareInput, internalShareInput } from "../../../shared/src/shares";
import { accessPrincipal, authorizationAssertion, authorizeNode } from "../auth/authorize";
import { type AccessSession, assertLiveAccessCredential } from "../auth/sessions";
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

const CLOCK = "strftime('%s','now')*1000";
export function shareAccess(session: AccessSession): SqlStatement[] {
  return [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      `SELECT 1 FROM control c JOIN credentials cr ON cr.id=? JOIN sessions s ON s.id=cr.session_id
      WHERE c.singleton=1 AND c.epoch=? AND c.maintenance=0 AND cr.kind='access' AND s.user_id=?`,
      [session.credential_id, session.epoch, session.user_id],
    ),
  ];
}
async function ownRoot(db: D1Database, session: AccessSession, id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("share_unavailable");
  const space = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=? AND owner_id=?")
    .bind(id, session.user_id)
    .first<string>("space_id");
  if (!space) throw new Error("share_unavailable");
  const proof = await authorizeNode(db, accessPrincipal(session), {
    operation: "node.read",
    nodeId: id,
    spaceId: space,
  });
  if (proof.operation !== "node.read" || proof.node.owner_id !== session.user_id)
    throw new Error("share_unavailable");
  return proof;
}
async function recipients(db: D1Database, session: AccessSession, input: InternalShareInput) {
  const found: { id: string; email: string }[] = [];
  for (const email of input.recipients) {
    // Email is not globally unique in the identity catalogue. Never select an arbitrary account.
    const rows = await primary(db)
      .prepare("SELECT id,email FROM users WHERE lower(email)=? AND disabled_at IS NULL LIMIT 2")
      .bind(email)
      .all<{ id: string; email: string }>();
    if (rows.results.length !== 1 || rows.results[0]!.id === session.user_id)
      throw new Error("share_recipient_unavailable");
    found.push(rows.results[0]!);
  }
  return found;
}
function recipientFences(rows: { id: string; email: string }[]): SqlStatement[] {
  return rows.map((row) =>
    assertExists(
      `SELECT 1 FROM users WHERE id=? AND email=? AND disabled_at IS NULL
    AND (SELECT COUNT(*) FROM users WHERE lower(email)=lower(?) AND disabled_at IS NULL)=1`,
      [row.id, row.email, row.email],
    ),
  );
}
function membership(
  id: string,
  version: number,
  rows: { id: string }[],
  role: InternalShareInput["role"],
): SqlStatement[] {
  return [
    { sql: "DELETE FROM share_actions WHERE share_id=?", values: [id] },
    ...(role === "read"
      ? ["read", "download"]
      : ["read", "download", "create", "edit", "upload"]
    ).map((action) => ({
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,?)",
      values: [id, action],
    })),
    {
      sql: `UPDATE share_grants SET disabled_at=COALESCE(disabled_at,${CLOCK}) WHERE share_id=?`,
      values: [id],
    },
    ...rows.map((row) => ({
      sql: `INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,?)
      ON CONFLICT(share_id,user_id) DO UPDATE SET version=excluded.version,disabled_at=NULL`,
      values: [id, row.id, version],
    })),
  ];
}
function revokeSessions(id: string): SqlStatement[] {
  return [
    {
      sql: `UPDATE share_sessions SET revoked_at=COALESCE(revoked_at,${CLOCK}) WHERE share_id=?`,
      values: [id],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${CLOCK}) WHERE share_id=?`,
      values: [id],
    },
    {
      sql: `UPDATE tickets SET cancelled_at=COALESCE(cancelled_at,${CLOCK}) WHERE id IN (SELECT ticket_id FROM content_sessions WHERE share_id=?)`,
      values: [id],
    },
  ];
}
export async function createInternalShare(
  env: AccountMutationEnv,
  session: AccessSession,
  value: unknown,
) {
  const input = internalShareInput(value);
  await atomicBatch(env.DB, shareAccess(session));
  const proof = await ownRoot(env.DB, session, input.rootNodeId);
  const users = await recipients(env.DB, session, input);
  const id = `sh_${crypto.randomUUID().replaceAll("-", "")}`;
  const prefix = id.slice(3, 19) + "-";
  let suffix = proof.node.name || "Drive";
  while (
    new TextEncoder().encode(prefix + suffix).length > 255 ||
    [...(prefix + suffix)].length >= 255
  )
    suffix = [...suffix].slice(0, -1).join("");
  const mount = portableName(prefix + suffix.replace(/[. ]+$/, ""));
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "share.create",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...shareAccess(session),
    authorizationAssertion(proof),
    ...recipientFences(users),
    assertExists(`SELECT 1 WHERE ? IS NULL OR ?>${CLOCK}`, [input.expiresAt, input.expiresAt]),
    {
      sql: `INSERT INTO shares(id,owner_id,root_node_id,kind,version,expires_at,created_at,mount_name,mount_name_ci)
      VALUES(?,?,?,'internal',1,?,${CLOCK},?,?)`,
      values: [id, session.user_id, input.rootNodeId, input.expiresAt, mount.name, mount.nameCi],
    },
    assertOneChange,
    ...membership(id, 1, users, input.role),
  ]);
  return { id, version: 1 };
}
export async function updateInternalShare(
  env: AccountMutationEnv,
  session: AccessSession,
  id: string,
  version: number,
  value: unknown | null,
) {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("invalid_share_request");
  const input = value === null ? null : internalShareInput(value);
  await atomicBatch(env.DB, shareAccess(session));
  const share = await primary(env.DB)
    .prepare(
      "SELECT root_node_id AS root,version FROM shares WHERE id=? AND owner_id=? AND kind='internal' AND disabled_at IS NULL",
    )
    .bind(id, session.user_id)
    .first<{ root: string; version: number }>();
  if (!share) throw new Error("share_unavailable");
  if (share.version !== version) throw new Error("share_version_conflict");
  if (input && input.rootNodeId !== share.root) throw new Error("invalid_share_request");
  const proof = await ownRoot(env.DB, session, share.root);
  const users = input ? await recipients(env.DB, session, input) : [];
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    input ? "share.update" : "share.disable",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...shareAccess(session),
    authorizationAssertion(proof),
    ...recipientFences(users),
    assertExists(
      `SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind='internal' AND root_node_id=? AND version=? AND disabled_at IS NULL`,
      [id, session.user_id, share.root, version],
    ),
    ...(input
      ? [assertExists(`SELECT 1 WHERE ? IS NULL OR ?>${CLOCK}`, [input.expiresAt, input.expiresAt])]
      : []),
    input
      ? {
          sql: "UPDATE shares SET version=version+1,expires_at=? WHERE id=?",
          values: [input.expiresAt, id],
        }
      : {
          sql: `UPDATE shares SET version=version+1,disabled_at=${CLOCK} WHERE id=?`,
          values: [id],
        },
    assertOneChange,
    ...(input
      ? membership(id, version + 1, users, input.role)
      : [
          {
            sql: `UPDATE share_grants SET disabled_at=COALESCE(disabled_at,${CLOCK}) WHERE share_id=?`,
            values: [id],
          },
        ]),
    ...revokeSessions(id),
  ]);
  return { id, version: version + 1, disabled: input === null };
}
