import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizationBatchAssertions,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import type { UserNodeCursorTokens, UserNodeListKind } from "../auth/userNodeCursor";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_SIZE = 10;
const SCAN_SIZE = 16;

interface Candidate {
  nodeId: string;
  spaceId: string;
  lastOpenedAt: number | null;
}

interface StateNodeRow {
  id: string;
  parentId: string | null;
  ownerId: string;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
  size: number | null;
  mime: string | null;
  starred: number;
  lastOpenedAt: number | null;
}

type StateReadProof = Extract<
  AuthorizedNode,
  { operation: "recent.read" | "starred.read" | "recent.record" | "node.star" }
>;

function stateStatement(
  kind: UserNodeListKind,
  userId: string,
  nodeIds: readonly string[],
  lastOpenedAt: number | null,
  lastId: string | null,
): SqlStatement {
  const ids = nodeIds.map(() => "?").join(",");
  return kind === "recent"
    ? {
        sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,n.kind,n.revision,
          n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,b.size,
          b.mime_sniffed AS mime,s.starred,s.last_opened_at AS lastOpenedAt
          FROM user_node_state s
          JOIN nodes n ON n.id=s.node_id
          LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
            AND b.state IN ('committed','gc_candidate')
          WHERE s.user_id=? AND s.node_id IN (${ids}) AND s.last_opened_at IS NOT NULL
            AND (? IS NULL OR s.last_opened_at<? OR (s.last_opened_at=? AND s.node_id<?))
          ORDER BY s.last_opened_at DESC,s.node_id DESC LIMIT ${PAGE_SIZE}`,
        values: [userId, ...nodeIds, lastOpenedAt, lastOpenedAt, lastOpenedAt, lastId],
      }
    : {
        sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,n.kind,n.revision,
          n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,b.size,
          b.mime_sniffed AS mime,s.starred,s.last_opened_at AS lastOpenedAt
          FROM user_node_state s
          JOIN nodes n ON n.id=s.node_id
          LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
            AND b.state IN ('committed','gc_candidate')
          WHERE s.user_id=? AND s.node_id IN (${ids}) AND s.starred=1
            AND (? IS NULL OR s.node_id>?)
          ORDER BY s.node_id LIMIT ${PAGE_SIZE}`,
        values: [userId, ...nodeIds, lastId, lastId],
      };
}

async function currentProof(
  db: D1Database,
  principal: Principal,
  candidate: Candidate,
  kind: UserNodeListKind,
): Promise<StateReadProof | null> {
  try {
    return (await authorizeNode(db, principal, {
      operation: kind === "recent" ? "recent.read" : "starred.read",
      nodeId: candidate.nodeId,
      spaceId: candidate.spaceId,
    })) as StateReadProof;
  } catch (error) {
    if (error instanceof Error && error.message === "authorization_denied") return null;
    throw error;
  }
}

export async function listUserNodes(
  db: D1Database,
  principal: Principal,
  kind: UserNodeListKind,
  tokens: UserNodeCursorTokens,
  cursor?: string,
) {
  if (principal.kind !== "user") throw new Error("user_node_state_unavailable");
  let lastOpenedAt: number | null = null;
  let lastId: string | null = null;
  if (cursor !== undefined) {
    const claims = await tokens.verify(cursor);
    if (
      claims.kind !== kind ||
      claims.userId !== principal.user_id ||
      claims.credentialId !== principal.credential_id ||
      claims.epoch !== principal.epoch
    )
      throw new Error("invalid_user_node_cursor");
    lastOpenedAt = claims.lastOpenedAt;
    lastId = claims.lastId;
  }
  const candidates = (
    await primary(db)
      .prepare(
        kind === "recent"
          ? `SELECT s.node_id AS nodeId,n.space_id AS spaceId,s.last_opened_at AS lastOpenedAt
            FROM user_node_state s INDEXED BY user_node_state_recent
            JOIN nodes n ON n.id=s.node_id
            WHERE s.user_id=? AND s.last_opened_at IS NOT NULL
              AND (? IS NULL OR s.last_opened_at<? OR (s.last_opened_at=? AND s.node_id<?))
            ORDER BY s.last_opened_at DESC,s.node_id DESC LIMIT ${SCAN_SIZE + 1}`
          : `SELECT s.node_id AS nodeId,n.space_id AS spaceId,s.last_opened_at AS lastOpenedAt
            FROM user_node_state s INDEXED BY user_node_state_starred
            JOIN nodes n ON n.id=s.node_id
            WHERE s.user_id=? AND s.starred=1 AND (? IS NULL OR s.node_id>?)
            ORDER BY s.node_id LIMIT ${SCAN_SIZE + 1}`,
      )
      .bind(
        ...(kind === "recent"
          ? [principal.user_id, lastOpenedAt, lastOpenedAt, lastOpenedAt, lastId]
          : [principal.user_id, lastId, lastId]),
      )
      .all<Candidate>()
  ).results;
  const scan = candidates.slice(0, SCAN_SIZE);
  const proofs = (
    await Promise.all(scan.map((candidate) => currentProof(db, principal, candidate, kind)))
  ).filter((proof): proof is StateReadProof => proof !== null);
  let rows: StateNodeRow[] = [];
  if (proofs.length) {
    const ids = proofs.map((proof) => proof.node.id);
    const statements = [
      ...authorizationBatchAssertions(proofs),
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        principal.epoch,
      ]),
      stateStatement(kind, principal.user_id, ids, lastOpenedAt, lastId),
    ];
    const result = await atomicBatch(db, statements);
    rows = (result.at(-1)?.results ?? []) as StateNodeRow[];
  } else {
    await atomicBatch(db, [
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        principal.epoch,
      ]),
    ]);
  }
  const lastRow = rows.at(-1);
  const exhaustedVisiblePage = rows.length === PAGE_SIZE;
  const scanBoundary = scan.at(-1);
  const hasMore = exhaustedVisiblePage || candidates.length > SCAN_SIZE;
  const boundary = exhaustedVisiblePage
    ? { nodeId: lastRow!.id, lastOpenedAt: lastRow!.lastOpenedAt }
    : scanBoundary;
  const nextCursor =
    hasMore && boundary
      ? await tokens.issue({
          kind,
          userId: principal.user_id,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          lastOpenedAt: kind === "recent" ? boundary.lastOpenedAt : null,
          lastId: boundary.nodeId,
        })
      : null;
  return Object.freeze({
    kind,
    items: rows.map(({ starred, ...row }) => ({ ...row, starred: starred === 1 })),
    nextCursor,
  });
}

async function nodeProof(
  db: D1Database,
  principal: Principal,
  nodeId: string,
  operation: "node.star" | "recent.record",
) {
  if (principal.kind !== "user" || !ID.test(nodeId)) throw new Error("user_node_state_unavailable");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("user_node_state_unavailable");
  return authorizeNode(db, principal, { operation, nodeId, spaceId });
}

export async function setNodeStar(
  env: Pick<Env, "DB" | "CONTROL">,
  principal: Principal,
  nodeId: string,
  starred: boolean,
): Promise<{ starred: boolean }> {
  if (principal.kind !== "user") throw new Error("user_node_state_unavailable");
  const proof = await nodeProof(env.DB, principal, nodeId, "node.star");
  const admission = await acquireAccountMutation(
    env,
    principal.user_id,
    principal.epoch,
    "node.star",
  );
  const statements: SqlStatement[] = [authorizationAssertion(proof)];
  if (starred) {
    statements.push({
      sql: `INSERT INTO user_node_state(user_id,node_id,starred)
        VALUES(?,?,1) ON CONFLICT(user_id,node_id) DO UPDATE SET starred=1`,
      values: [principal.user_id, nodeId],
    });
  } else {
    statements.push(
      {
        sql: "DELETE FROM user_node_state WHERE user_id=? AND node_id=? AND last_opened_at IS NULL",
        values: [principal.user_id, nodeId],
      },
      {
        sql: `UPDATE user_node_state SET starred=0
          WHERE user_id=? AND node_id=? AND last_opened_at IS NOT NULL`,
        values: [principal.user_id, nodeId],
      },
    );
  }
  await commitAccountMutation(env.DB, admission, principal.user_id, statements);
  return Object.freeze({ starred });
}

export async function recordNodeOpen(
  env: Pick<Env, "DB" | "CONTROL">,
  principal: Principal,
  nodeId: string,
  now = Date.now(),
): Promise<{ recorded: boolean }> {
  if (principal.kind !== "user") throw new Error("user_node_state_unavailable");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("user_node_state_unavailable");
  const proof = await nodeProof(env.DB, principal, nodeId, "recent.record");
  const previous = await primary(env.DB)
    .prepare("SELECT last_opened_at FROM user_node_state WHERE user_id=? AND node_id=?")
    .bind(principal.user_id, nodeId)
    .first<number>("last_opened_at");
  if (previous !== null && previous > now - 60_000) return Object.freeze({ recorded: false });
  const admission = await acquireAccountMutation(
    env,
    principal.user_id,
    principal.epoch,
    "recent.record",
  );
  await commitAccountMutation(env.DB, admission, principal.user_id, [
    authorizationAssertion(proof),
    {
      sql: `INSERT INTO user_node_state(user_id,node_id,last_opened_at)
        VALUES(?,?,?) ON CONFLICT(user_id,node_id) DO UPDATE SET last_opened_at=excluded.last_opened_at
        WHERE user_node_state.last_opened_at IS NULL
          OR user_node_state.last_opened_at<=excluded.last_opened_at-60000`,
      values: [principal.user_id, nodeId, now],
    },
  ]);
  return Object.freeze({ recorded: true });
}
