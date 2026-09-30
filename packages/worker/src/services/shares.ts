import { base64url } from "jose";
import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { type AccessSession, assertLiveAccessCredential } from "../auth/sessions";
import { hashSharePassword, type SharePasswordPepperRing } from "../auth/sharePassword";
import { shareSecretDigest } from "../auth/shareSession";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;
const ACTIVE_SHARE_LIMIT = 100;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface CreateShareInput {
  readonly rootNodeId: string;
  readonly spaceId: string;
  readonly ttlDays?: number;
  readonly password?: string;
}

interface ShareRow {
  id: string;
  rootNodeId: string | null;
  version: number;
  disabledAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  passwordProtected: number;
}

function ulid(): string {
  let time = Date.now();
  const result = Array<string>(26);
  for (let index = 9; index >= 0; index--) {
    result[index] = ALPHABET[time % 32]!;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < 16; index++) result[index + 10] = ALPHABET[random[index]! & 31]!;
  return `sh_${result.join("")}`;
}

function currentAccess(session: AccessSession): SqlStatement[] {
  return [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      session.epoch,
    ]),
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      `SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
        WHERE c.id=? AND c.kind='access' AND s.user_id=? AND s.epoch=?`,
      [session.credential_id, session.user_id, session.epoch],
    ),
  ];
}

function output(row: ShareRow) {
  return {
    id: row.id,
    rootNodeId: row.rootNodeId,
    version: row.version,
    disabledAt: row.disabledAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    passwordProtected: row.passwordProtected === 1,
    actions: ["read", "download"] as const,
  };
}

export async function listShares(db: D1Database, session: AccessSession) {
  const statements = currentAccess(session);
  await atomicBatch(db, statements);
  const rows = await primary(db)
    .prepare(`SELECT id,root_node_id AS rootNodeId,version,disabled_at AS disabledAt,
      expires_at AS expiresAt,created_at AS createdAt,
      password_digest IS NOT NULL AS passwordProtected
      FROM shares WHERE owner_id=? AND kind='link'
      ORDER BY created_at DESC,id DESC LIMIT 100`)
    .bind(session.user_id)
    .all<ShareRow>();
  await atomicBatch(db, statements);
  return rows.results.map(output);
}

export async function readShare(db: D1Database, session: AccessSession, shareId: string) {
  if (!ID.test(shareId)) throw new Error("share_not_found");
  const statements = currentAccess(session);
  await atomicBatch(db, statements);
  const row = await primary(db)
    .prepare(`SELECT id,root_node_id AS rootNodeId,version,disabled_at AS disabledAt,
      expires_at AS expiresAt,created_at AS createdAt,
      password_digest IS NOT NULL AS passwordProtected
      FROM shares WHERE id=? AND owner_id=? AND kind='link'`)
    .bind(shareId, session.user_id)
    .first<ShareRow>();
  if (!row) throw new Error("share_not_found");
  await atomicBatch(db, statements);
  return output(row);
}

export async function createShare(
  env: Env,
  session: AccessSession,
  input: CreateShareInput,
  passwordRing?: SharePasswordPepperRing,
  signal?: AbortSignal,
) {
  if (
    !ID.test(input.rootNodeId) ||
    !ID.test(input.spaceId) ||
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365)) ||
    (input.password !== undefined && typeof input.password !== "string")
  )
    throw new Error("invalid_share_request");
  const principal = {
    kind: "user" as const,
    user_id: session.user_id,
    credential_id: session.credential_id,
    epoch: session.epoch,
  };
  let root;
  try {
    root = await authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: input.rootNodeId,
      spaceId: input.spaceId,
    });
  } catch {
    throw new Error("share_root_not_found");
  }
  if (root.operation !== "node.read" || root.node.owner_id !== session.user_id)
    throw new Error("share_root_not_found");
  const active = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM shares WHERE owner_id=? AND kind='link'
      AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000)`)
    .bind(session.user_id)
    .first<number>("count");
  if (active === null || active >= ACTIVE_SHARE_LIMIT) throw new Error("share_limit");
  const id = ulid();
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const secretDigest = await shareSecretDigest(secret);
  let passwordRecord;
  if (input.password !== undefined) {
    if (!passwordRing) throw new Error("share_password_unavailable");
    passwordRecord = await hashSharePassword(input.password, passwordRing, signal);
  }
  const now = Date.now();
  const expiresAt = now + (input.ttlDays ?? 30) * DAY_MS;
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "share.create",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...currentAccess(session),
    authorizationAssertion(root),
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM shares WHERE owner_id=? AND kind='link'
        AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000))<?`,
      [session.user_id, ACTIVE_SHARE_LIMIT],
    ),
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,secret_digest,password_digest,salt,kdf,kdf_params,kid,
        expires_at,created_at
      ) VALUES(?,?,?,'link',?,?,?,?,?,?,?,?)`,
      values: [
        id,
        session.user_id,
        root.node.id,
        secretDigest,
        passwordRecord?.passwordDigest ?? null,
        passwordRecord?.salt ?? null,
        passwordRecord?.kdf ?? null,
        passwordRecord?.kdfParams ?? null,
        passwordRecord?.kid ?? null,
        expiresAt,
        now,
      ],
    },
    {
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read'),(?,'download')",
      values: [id, id],
    },
  ]);
  const created = await readShare(env.DB, session, id);
  return { ...created, secret };
}

export async function disableShare(
  env: Env,
  session: AccessSession,
  shareId: string,
): Promise<void> {
  if (!ID.test(shareId)) throw new Error("share_not_found");
  const exists = await primary(env.DB)
    .prepare("SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind='link'")
    .bind(shareId, session.user_id)
    .first();
  if (!exists) throw new Error("share_not_found");
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "share.disable",
  );
  const clock = "strftime('%s','now')*1000";
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...currentAccess(session),
    assertExists("SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind='link'", [
      shareId,
      session.user_id,
    ]),
    {
      sql: `UPDATE shares SET disabled_at=COALESCE(disabled_at,${clock}),
        version=CASE WHEN disabled_at IS NULL THEN version+1 ELSE version END
        WHERE id=? AND owner_id=? AND kind='link'`,
      values: [shareId, session.user_id],
    },
    {
      sql: `UPDATE share_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE share_id=?`,
      values: [shareId],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE share_id=?`,
      values: [shareId],
    },
    {
      sql: "UPDATE budgets SET state='revoked' WHERE share_id=? AND state='active'",
      values: [shareId],
    },
  ]);
}
