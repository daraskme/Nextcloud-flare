import { portableName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { type AccessSession, assertLiveAccessCredential } from "../auth/sessions";
import { hashSharePassword, type SharePasswordPepperRing } from "../auth/sharePassword";
import { shareSecretDigest } from "../auth/shareSession";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { digestJson } from "../jobs/operations";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;
const ACTIVE_SHARE_LIMIT = 100;
const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024 * 1024;
const MAX_UPLOAD_LIMIT = 500 * 1024 * 1024 * 1024;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface CreateShareInput {
  readonly rootNodeId: string;
  readonly spaceId: string;
  readonly kind?: "link" | "upload_only";
  readonly ttlDays?: number;
  readonly password?: string;
  readonly reservationLimitBytes?: number;
}

export interface CreateInternalShareInput {
  readonly rootNodeId: string;
  readonly spaceId: string;
  readonly recipientEmail?: string;
  readonly recipientGroupId?: string;
  readonly actions: readonly string[];
  readonly ttlDays?: number;
  readonly sourceShareId?: string;
  readonly idempotencyKey?: string;
  readonly resharePolicy?: ResharePolicyInput;
}

export interface ResharePolicyInput {
  readonly enabled: boolean;
  readonly actions: readonly string[];
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly ttlDays?: number;
}

export interface UpdateInternalShareInput {
  readonly actions?: readonly string[];
  readonly resharePolicy?: ResharePolicyInput;
}

interface ShareRow {
  id: string;
  kind: "link" | "upload_only" | "internal";
  rootNodeId: string | null;
  rootName: string | null;
  version: number;
  disabledAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  passwordProtected: number;
  reservedBytes: number;
  reservationLimit: number;
  actions: string;
  recipientUserId: string | null;
  recipientEmail: string | null;
  recipientGroupId: string | null;
  recipientGroupName: string | null;
  mountName: string | null;
  sourceShareId: string | null;
  delegatedByUserId: string | null;
  delegationDepth: number | null;
  policyEnabled: number | null;
  policyActions: string;
  policyMaxDepth: number | null;
  policyMaxFanout: number | null;
  policyExpiresAt: number | null;
  policyVersion: number | null;
}

interface ShareOutput {
  id: string;
  kind: ShareRow["kind"];
  rootNodeId: string | null;
  rootName: string | null;
  version: number;
  disabledAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  passwordProtected: boolean;
  actions: string[];
  reservedBytes?: number;
  reservationLimit?: number;
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  recipientGroupId?: string | null;
  recipientGroupName?: string | null;
  mountId?: string;
  mountName?: string | null;
  sourceShareId?: string | null;
  delegatedByUserId?: string | null;
  delegationDepth?: number;
  resharePolicy?: {
    enabled: boolean;
    actions: string[];
    maxDepth: number;
    maxFanout: number;
    expiresAt: number | null;
    version: number;
  } | null;
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

function output(row: ShareRow): ShareOutput {
  return {
    id: row.id,
    kind: row.kind,
    rootNodeId: row.rootNodeId,
    rootName: row.rootName,
    version: row.version,
    disabledAt: row.disabledAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    passwordProtected: row.passwordProtected === 1,
    actions: orderedActions(row.kind, JSON.parse(row.actions) as string[]),
    ...(row.kind === "internal"
      ? {
          recipientUserId: row.recipientUserId,
          recipientEmail: row.recipientEmail,
          recipientGroupId: row.recipientGroupId,
          recipientGroupName: row.recipientGroupName,
          mountId: row.id,
          mountName: row.mountName,
          sourceShareId: row.sourceShareId,
          delegatedByUserId: row.delegatedByUserId,
          delegationDepth: row.delegationDepth ?? 0,
          resharePolicy:
            row.policyVersion === null
              ? null
              : {
                  enabled: row.policyEnabled === 1,
                  actions: canonicalActions(JSON.parse(row.policyActions) as string[]),
                  maxDepth: row.policyMaxDepth!,
                  maxFanout: row.policyMaxFanout!,
                  expiresAt: row.policyExpiresAt,
                  version: row.policyVersion,
                },
        }
      : {
          reservedBytes: row.reservedBytes,
          reservationLimit: row.reservationLimit,
        }),
  };
}

function canonicalActions(actions: readonly string[]) {
  return ["read", "download", "create", "edit"].filter((action) => actions.includes(action));
}

function orderedActions(kind: ShareRow["kind"], actions: readonly string[]) {
  if (kind === "internal") return canonicalActions(actions);
  return (kind === "upload_only" ? ["create", "upload"] : ["read", "download"]).filter((action) =>
    actions.includes(action),
  );
}

const SHARE_SELECT = `SELECT sh.id,sh.kind,sh.root_node_id AS rootNodeId,root.name AS rootName,sh.version,
  sh.disabled_at AS disabledAt,sh.expires_at AS expiresAt,sh.created_at AS createdAt,
  sh.password_digest IS NOT NULL AS passwordProtected,sh.reserved_bytes AS reservedBytes,
  sh.reservation_limit AS reservationLimit,
  COALESCE((SELECT json_group_array(action) FROM (
    SELECT action FROM share_actions WHERE share_id=sh.id ORDER BY action
  )),'[]') AS actions,
  g.user_id AS recipientUserId,u.email AS recipientEmail,
  gg.group_id AS recipientGroupId,sg.name AS recipientGroupName,sh.mount_name AS mountName,
  delegation.source_share_id AS sourceShareId,
  delegation.delegated_by_user_id AS delegatedByUserId,
  delegation.depth AS delegationDepth,
  policy.enabled AS policyEnabled,
  COALESCE((SELECT json_group_array(action) FROM (
    SELECT action FROM share_reshare_policy_actions
    WHERE share_id=policy.share_id ORDER BY action
  )),'[]') AS policyActions,
  policy.max_depth AS policyMaxDepth,policy.max_fanout AS policyMaxFanout,
  policy.expires_at AS policyExpiresAt,policy.version AS policyVersion
  FROM shares sh
  LEFT JOIN nodes root ON root.id=sh.root_node_id AND root.owner_id=sh.owner_id
  LEFT JOIN share_grants g ON g.share_id=sh.id
  LEFT JOIN users u ON u.id=g.user_id
  LEFT JOIN share_group_grants gg ON gg.share_id=sh.id
  LEFT JOIN share_groups sg ON sg.id=gg.group_id
  LEFT JOIN share_delegations delegation ON delegation.share_id=sh.id
  LEFT JOIN share_reshare_policies policy
    ON policy.share_id=COALESCE(delegation.policy_share_id,sh.id)`;

export async function listShares(db: D1Database, session: AccessSession) {
  const statements = currentAccess(session);
  await atomicBatch(db, statements);
  const rows = await primary(db)
    .prepare(`${SHARE_SELECT} WHERE sh.owner_id=? AND sh.kind IN ('link','upload_only','internal')
      AND (delegation.share_id IS NULL
        OR EXISTS(SELECT 1 FROM current_internal_shares current WHERE current.share_id=sh.id))
      ORDER BY sh.created_at DESC,sh.id DESC LIMIT 100`)
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
    .prepare(`${SHARE_SELECT}
      WHERE sh.id=? AND sh.owner_id=? AND sh.kind IN ('link','upload_only','internal')
        AND (delegation.share_id IS NULL
          OR EXISTS(SELECT 1 FROM current_internal_shares current WHERE current.share_id=sh.id))`)
    .bind(shareId, session.user_id)
    .first<ShareRow>();
  if (!row) throw new Error("share_not_found");
  await atomicBatch(db, statements);
  return output(row);
}

function validatedActions(actions: readonly string[]) {
  if (
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > 4 ||
    actions.some((action) => !["read", "download", "create", "edit"].includes(action)) ||
    new Set(actions).size !== actions.length ||
    (actions.some((action) => action !== "read") && !actions.includes("read"))
  )
    throw new Error("invalid_share_request");
  return canonicalActions(actions);
}

function validatedPolicy(input: ResharePolicyInput | undefined) {
  if (input === undefined) return undefined;
  if (
    typeof input !== "object" ||
    typeof input.enabled !== "boolean" ||
    !Number.isInteger(input.maxDepth) ||
    input.maxDepth < 1 ||
    input.maxDepth > 4 ||
    !Number.isInteger(input.maxFanout) ||
    input.maxFanout < 1 ||
    input.maxFanout > 20 ||
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365))
  )
    throw new Error("invalid_share_request");
  return Object.freeze({ ...input, actions: validatedActions(input.actions) });
}

interface SourceAuthority {
  readonly id: string;
  readonly ownerId: string;
  readonly rootNodeId: string;
  readonly rootParentId: string | null;
  readonly spaceId: string;
  readonly version: number;
  readonly expiresAt: number | null;
  readonly depth: number;
  readonly policyShareId: string;
  readonly policyVersion: number;
  readonly policyExpiresAt: number | null;
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly currentFanout: number;
  readonly actions: string;
  readonly policyActions: string;
  readonly sourceGroupId: string | null;
  readonly membershipVersion: number | null;
}

const SOURCE_AUTHORITY_SELECT = `SELECT source.id,source.owner_id AS ownerId,
  source.root_node_id AS rootNodeId,root.parent_id AS rootParentId,root.space_id AS spaceId,
  source.version,source.expires_at AS expiresAt,current.depth,
  policy.share_id AS policyShareId,policy.version AS policyVersion,
  policy.expires_at AS policyExpiresAt,policy.max_depth AS maxDepth,
  policy.max_fanout AS maxFanout,
  (SELECT COUNT(*) FROM share_delegations child
    JOIN share_delegation_status status ON status.share_id=child.share_id AND status.valid=1
    JOIN shares child_share ON child_share.id=child.share_id AND child_share.disabled_at IS NULL
      AND (child_share.expires_at IS NULL OR child_share.expires_at>strftime('%s','now')*1000)
    WHERE child.source_share_id=source.id) AS currentFanout,
  (SELECT json_group_array(action) FROM (
    SELECT action FROM share_actions WHERE share_id=source.id ORDER BY action
  )) AS actions,
  (SELECT json_group_array(action) FROM (
    SELECT action FROM share_reshare_policy_actions
    WHERE share_id=policy.share_id ORDER BY action
  )) AS policyActions,
  grouped.group_id AS sourceGroupId,member.version AS membershipVersion
FROM current_internal_shares current
JOIN shares source ON source.id=current.share_id
JOIN nodes root ON root.id=source.root_node_id AND root.owner_id=source.owner_id
JOIN share_reshare_policies policy
  ON policy.share_id=COALESCE(current.policy_share_id,source.id)
  AND policy.version=COALESCE(current.policy_version,policy.version)
  AND policy.enabled=1
LEFT JOIN share_grants direct ON direct.share_id=source.id AND direct.user_id=?
  AND direct.disabled_at IS NULL AND direct.version=source.version
LEFT JOIN share_group_grants grouped ON grouped.share_id=source.id
LEFT JOIN share_groups recipient_group ON recipient_group.id=grouped.group_id
  AND recipient_group.owner_id=source.owner_id AND recipient_group.disabled_at IS NULL
LEFT JOIN share_group_members member ON member.group_id=recipient_group.id
  AND member.user_id=? AND member.disabled_at IS NULL
LEFT JOIN users delegated_user ON delegated_user.id=member.user_id
  AND delegated_user.disabled_at IS NULL
WHERE source.id=? AND (direct.user_id IS NOT NULL OR delegated_user.id IS NOT NULL)
  AND (policy.expires_at IS NULL OR policy.expires_at>strftime('%s','now')*1000)
ORDER BY grouped.group_id LIMIT 2`;

async function sourceAuthority(
  db: D1Database,
  session: AccessSession,
  sourceShareId: string,
): Promise<SourceAuthority> {
  const rows = await primary(db)
    .prepare(SOURCE_AUTHORITY_SELECT)
    .bind(session.user_id, session.user_id, sourceShareId)
    .all<SourceAuthority>();
  if (rows.results.length !== 1) throw new Error("share_source_not_found");
  return rows.results[0]!;
}

function sourceAuthorityAssertion(session: AccessSession, source: SourceAuthority): SqlStatement {
  return assertExists(
    `SELECT 1 FROM current_internal_shares current
      JOIN shares source ON source.id=current.share_id
      JOIN nodes root ON root.id=source.root_node_id AND root.owner_id=source.owner_id
      JOIN share_reshare_policies policy
        ON policy.share_id=? AND policy.version=? AND policy.enabled=1
      WHERE source.id=? AND source.version=? AND source.owner_id=?
        AND source.root_node_id=? AND root.parent_id IS ? AND current.depth=?
        AND (policy.expires_at IS NULL OR policy.expires_at>strftime('%s','now')*1000)
        AND (SELECT COUNT(*) FROM share_delegations child
          JOIN share_delegation_status status
            ON status.share_id=child.share_id AND status.valid=1
          JOIN shares child_share ON child_share.id=child.share_id
            AND child_share.disabled_at IS NULL
            AND (child_share.expires_at IS NULL
              OR child_share.expires_at>strftime('%s','now')*1000)
          WHERE child.source_share_id=source.id)<?
        AND (
          (? IS NULL AND EXISTS(
            SELECT 1 FROM share_grants direct
            WHERE direct.share_id=source.id AND direct.user_id=?
              AND direct.disabled_at IS NULL AND direct.version=source.version
          ))
          OR
          (? IS NOT NULL AND EXISTS(
            SELECT 1 FROM share_group_grants grouped
            JOIN share_groups recipient_group ON recipient_group.id=grouped.group_id
              AND recipient_group.owner_id=source.owner_id
              AND recipient_group.disabled_at IS NULL
            JOIN share_group_members member ON member.group_id=recipient_group.id
              AND member.user_id=? AND member.disabled_at IS NULL
              AND member.version=?
            JOIN users delegated_user ON delegated_user.id=member.user_id
              AND delegated_user.disabled_at IS NULL
            WHERE grouped.share_id=source.id AND recipient_group.id=?
          ))
        )`,
    [
      source.policyShareId,
      source.policyVersion,
      source.id,
      source.version,
      source.ownerId,
      source.rootNodeId,
      source.rootParentId,
      source.depth,
      source.maxFanout,
      source.sourceGroupId,
      session.user_id,
      source.sourceGroupId,
      session.user_id,
      source.membershipVersion,
      source.sourceGroupId,
    ],
  );
}

function descendantRevocationStatements(shareId: string): readonly SqlStatement[] {
  const descendants = `WITH RECURSIVE descendants(id) AS (
    SELECT ?
    UNION ALL
    SELECT delegation.share_id FROM share_delegations delegation
    JOIN descendants ON descendants.id=delegation.source_share_id
  )`;
  const clock = "strftime('%s','now')*1000";
  return [
    {
      sql: `${descendants} UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE share_id IN (SELECT id FROM descendants)`,
      values: [shareId],
    },
    {
      sql: `${descendants} UPDATE budgets SET state='revoked'
        WHERE share_id IN (SELECT id FROM descendants) AND state='active'`,
      values: [shareId],
    },
  ];
}

async function reshareRequestIdentity(session: AccessSession, input: CreateInternalShareInput) {
  if (!input.idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey))
    throw new Error("invalid_idempotency_key");
  const id = `rs_${await digestJson([
    session.user_id,
    session.credential_id,
    input.idempotencyKey,
  ])}`;
  const digest = await digestJson({
    sourceShareId: input.sourceShareId,
    rootNodeId: input.rootNodeId,
    spaceId: input.spaceId,
    recipientEmail: input.recipientEmail?.normalize("NFC").trim().toLowerCase() ?? null,
    recipientGroupId: input.recipientGroupId ?? null,
    actions: canonicalActions(input.actions),
    ttlDays: input.ttlDays ?? 30,
  });
  return Object.freeze({ id, digest });
}

function stableMountName(shareId: string, rootName: string) {
  const prefix = `${shareId.slice(3)}-`;
  let suffix = "";
  for (const character of rootName) {
    if (new TextEncoder().encode(prefix + suffix + character).byteLength > 255) break;
    suffix += character;
  }
  return portableName(prefix + (suffix || "Shared"));
}

export async function createInternalShare(
  env: Env,
  session: AccessSession,
  input: CreateInternalShareInput,
) {
  if (
    !ID.test(input.rootNodeId) ||
    !ID.test(input.spaceId) ||
    (input.recipientEmail === undefined) === (input.recipientGroupId === undefined) ||
    (input.recipientEmail !== undefined &&
      (typeof input.recipientEmail !== "string" ||
        input.recipientEmail.length < 3 ||
        input.recipientEmail.length > 320)) ||
    (input.recipientGroupId !== undefined && !ID.test(input.recipientGroupId)) ||
    (input.sourceShareId !== undefined && !ID.test(input.sourceShareId)) ||
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365))
  )
    throw new Error("invalid_share_request");
  const actions = validatedActions(input.actions);
  const policyInput = validatedPolicy(input.resharePolicy);
  if (input.sourceShareId !== undefined && policyInput !== undefined)
    throw new Error("invalid_share_request");
  const requestIdentity =
    input.sourceShareId === undefined ? undefined : await reshareRequestIdentity(session, input);
  if (requestIdentity) {
    const existingRequest = await primary(env.DB)
      .prepare(
        "SELECT request_digest AS digest,share_id AS shareId FROM share_reshare_requests WHERE id=? AND credential_id=?",
      )
      .bind(requestIdentity.id, session.credential_id)
      .first<{ digest: string; shareId: string }>();
    if (existingRequest) {
      if (existingRequest.digest !== requestIdentity.digest)
        throw new Error("idempotency_conflict");
      await sourceAuthority(env.DB, session, input.sourceShareId!);
      return readReshareResult(env.DB, session, requestIdentity.id, existingRequest.shareId);
    }
  }
  await atomicBatch(env.DB, currentAccess(session));
  const source =
    input.sourceShareId === undefined
      ? undefined
      : await sourceAuthority(env.DB, session, input.sourceShareId);
  const ownerId = source?.ownerId ?? session.user_id;
  const recipientEmail = input.recipientEmail?.normalize("NFC").trim();
  let recipient: { id: string; email: string } | undefined;
  let recipientGroup: { id: string; name: string } | undefined;
  if (recipientEmail !== undefined) {
    const recipients = await primary(env.DB)
      .prepare(`SELECT id,email FROM users WHERE lower(email)=lower(?) AND disabled_at IS NULL
        ORDER BY id LIMIT 2`)
      .bind(recipientEmail)
      .all<{ id: string; email: string }>();
    recipient = recipients.results.length === 1 ? recipients.results[0] : undefined;
    if (!recipient || recipient.id === session.user_id)
      throw new Error("share_recipient_not_found");
  } else {
    recipientGroup =
      (await primary(env.DB)
        .prepare(`SELECT g.id,g.name FROM share_groups g
        WHERE g.id=? AND g.owner_id=? AND g.disabled_at IS NULL
          AND (SELECT COUNT(*) FROM share_group_members gm
            JOIN users u ON u.id=gm.user_id AND u.disabled_at IS NULL
            WHERE gm.group_id=g.id AND gm.disabled_at IS NULL)<=100`)
        .bind(input.recipientGroupId, ownerId)
        .first<{ id: string; name: string }>()) ?? undefined;
    if (!recipientGroup) throw new Error("share_recipient_not_found");
  }
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
  if (
    root.operation !== "node.read" ||
    root.node.owner_id !== ownerId ||
    root.node.kind !== "folder"
  )
    throw new Error("share_root_not_found");
  if (source) {
    const withinSource = await primary(env.DB)
      .prepare(`WITH RECURSIVE ancestry(id,parent_id,depth,path) AS (
        SELECT id,parent_id,0,'/'||id||'/' FROM nodes
        WHERE id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL
        UNION ALL
        SELECT parent.id,parent.parent_id,ancestry.depth+1,ancestry.path||parent.id||'/'
        FROM ancestry JOIN nodes parent ON parent.id=ancestry.parent_id
        WHERE ancestry.depth<64 AND parent.space_id=? AND parent.owner_id=?
          AND parent.deleted_at IS NULL AND instr(ancestry.path,'/'||parent.id||'/')=0
      ) SELECT 1 FROM ancestry WHERE id=?`)
      .bind(
        root.node.id,
        root.node.space_id,
        ownerId,
        root.node.space_id,
        ownerId,
        source.rootNodeId,
      )
      .first();
    if (!withinSource) throw new Error("share_root_not_found");
    const sourceActions = canonicalActions(JSON.parse(source.actions) as string[]);
    const policyActions = canonicalActions(JSON.parse(source.policyActions) as string[]);
    if (
      actions.some(
        (action) => !sourceActions.includes(action) || !policyActions.includes(action),
      ) ||
      source.depth + 1 > source.maxDepth ||
      source.currentFanout >= source.maxFanout
    )
      throw new Error("share_authority_exceeded");
  }
  const existing = recipient
    ? await primary(env.DB)
        .prepare(`SELECT 1 FROM shares sh
          JOIN current_internal_shares current ON current.share_id=sh.id
          JOIN share_grants g ON g.share_id=sh.id
          WHERE sh.owner_id=? AND sh.root_node_id=? AND sh.kind='internal'
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND g.user_id=? AND g.disabled_at IS NULL AND g.version=sh.version`)
        .bind(ownerId, root.node.id, recipient.id)
        .first<number>()
    : await primary(env.DB)
        .prepare(`SELECT 1 FROM shares sh
          JOIN current_internal_shares current ON current.share_id=sh.id
          JOIN share_group_grants gg ON gg.share_id=sh.id
          JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
          WHERE sh.owner_id=? AND sh.root_node_id=? AND sh.kind='internal'
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND sg.id=? AND sg.disabled_at IS NULL`)
        .bind(ownerId, root.node.id, recipientGroup!.id)
        .first<number>();
  if (existing !== null) throw new Error("share_exists");
  const active = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM shares sh
      JOIN current_internal_shares current ON current.share_id=sh.id
      WHERE sh.owner_id=? AND sh.kind='internal'
        AND sh.disabled_at IS NULL
        AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)`)
    .bind(ownerId)
    .first<number>("count");
  if (active === null || active >= ACTIVE_SHARE_LIMIT) throw new Error("share_limit");
  const id = ulid();
  const mount = stableMountName(id, root.node.name);
  const now = Date.now();
  const requestedExpiresAt = now + (input.ttlDays ?? 30) * DAY_MS;
  const expiresAt = source
    ? input.ttlDays === undefined
      ? Math.min(
          requestedExpiresAt,
          source.expiresAt ?? requestedExpiresAt,
          source.policyExpiresAt ?? requestedExpiresAt,
        )
      : requestedExpiresAt
    : requestedExpiresAt;
  if (
    source &&
    ((source.expiresAt !== null && expiresAt > source.expiresAt) ||
      (source.policyExpiresAt !== null && expiresAt > source.policyExpiresAt))
  )
    throw new Error("share_authority_exceeded");
  const policyExpiresAt =
    policyInput?.ttlDays === undefined ? null : now + policyInput.ttlDays * DAY_MS;
  if (
    policyInput &&
    (policyInput.actions.some((action) => !actions.includes(action)) ||
      (policyExpiresAt !== null && policyExpiresAt > expiresAt))
  )
    throw new Error("invalid_share_request");
  const admission = await acquireAccountMutation(env, ownerId, session.epoch, "share.create");
  const delegationStatements: SqlStatement[] = source
    ? [
        sourceAuthorityAssertion(session, source),
        assertExists(
          `WITH RECURSIVE ancestry(id,parent_id,depth,path) AS (
            SELECT id,parent_id,0,'/'||id||'/' FROM nodes
            WHERE id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL
            UNION ALL
            SELECT parent.id,parent.parent_id,ancestry.depth+1,ancestry.path||parent.id||'/'
            FROM ancestry JOIN nodes parent ON parent.id=ancestry.parent_id
            WHERE ancestry.depth<64 AND parent.space_id=? AND parent.owner_id=?
              AND parent.deleted_at IS NULL
              AND instr(ancestry.path,'/'||parent.id||'/')=0
          ) SELECT 1 FROM ancestry WHERE id=?`,
          [
            root.node.id,
            root.node.space_id,
            ownerId,
            root.node.space_id,
            ownerId,
            source.rootNodeId,
          ],
        ),
      ]
    : [];
  const policyStatements: SqlStatement[] =
    policyInput === undefined
      ? []
      : [
          {
            sql: `INSERT INTO share_reshare_policies(
              share_id,enabled,max_depth,max_fanout,expires_at,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?)`,
            values: [
              id,
              policyInput.enabled ? 1 : 0,
              policyInput.maxDepth,
              policyInput.maxFanout,
              policyExpiresAt,
              now,
              now,
            ],
          },
          ...policyInput.actions.map((action) => ({
            sql: "INSERT INTO share_reshare_policy_actions(share_id,action) VALUES(?,?)",
            values: [id, action],
          })),
        ];
  await commitAccountMutation(env.DB, admission, ownerId, [
    ...currentAccess(session),
    authorizationAssertion(root),
    ...delegationStatements,
    recipient
      ? assertExists(
          `SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND lower(email)=lower(?)
            AND (SELECT COUNT(*) FROM users WHERE disabled_at IS NULL AND lower(email)=lower(?))=1`,
          [recipient.id, recipient.email, recipient.email],
        )
      : assertExists(
          `SELECT 1 FROM share_groups g WHERE g.id=? AND g.owner_id=?
            AND g.disabled_at IS NULL AND
            (SELECT COUNT(*) FROM share_group_members gm
              JOIN users u ON u.id=gm.user_id AND u.disabled_at IS NULL
              WHERE gm.group_id=g.id AND gm.disabled_at IS NULL)<=100`,
          [recipientGroup!.id, ownerId],
        ),
    assertExists(
      `SELECT 1 WHERE
        (SELECT COUNT(*) FROM shares counted
          JOIN current_internal_shares current_counted ON current_counted.share_id=counted.id
          WHERE counted.owner_id=? AND counted.kind='internal'
            AND counted.disabled_at IS NULL
            AND (counted.expires_at IS NULL
              OR counted.expires_at>strftime('%s','now')*1000))<?
        AND NOT EXISTS(
          SELECT 1 FROM shares sh
          JOIN current_internal_shares current ON current.share_id=sh.id
          WHERE sh.owner_id=? AND sh.root_node_id=? AND sh.kind='internal'
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND ((? IS NOT NULL AND EXISTS(
              SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=?
                AND g.disabled_at IS NULL AND g.version=sh.version
            )) OR (? IS NOT NULL AND EXISTS(
              SELECT 1 FROM share_group_grants gg JOIN share_groups sg ON sg.id=gg.group_id
              WHERE gg.share_id=sh.id AND sg.id=? AND sg.owner_id=sh.owner_id
                AND sg.disabled_at IS NULL
            )))
        )`,
      [
        ownerId,
        ACTIVE_SHARE_LIMIT,
        ownerId,
        root.node.id,
        recipient?.id ?? null,
        recipient?.id ?? null,
        recipientGroup?.id ?? null,
        recipientGroup?.id ?? null,
      ],
    ),
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,expires_at,created_at,mount_name,mount_name_ci
      ) VALUES(?,?,?,'internal',?,?,?,?)`,
      values: [id, ownerId, root.node.id, expiresAt, now, mount.name, mount.nameCi],
    },
    recipient
      ? {
          sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
          values: [id, recipient.id],
        }
      : {
          sql: "INSERT INTO share_group_grants(share_id,group_id,created_at) VALUES(?,?,?)",
          values: [id, recipientGroup!.id, now],
        },
    ...actions.map((action) => ({
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,?)",
      values: [id, action],
    })),
    ...policyStatements,
    ...(source
      ? [
          {
            sql: `INSERT INTO share_delegations(
              share_id,source_share_id,source_share_version,policy_share_id,policy_version,
              delegated_by_user_id,source_group_id,source_membership_version,depth,
              source_root_parent_id,delegated_root_parent_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            values: [
              id,
              source.id,
              source.version,
              source.policyShareId,
              source.policyVersion,
              session.user_id,
              source.sourceGroupId,
              source.membershipVersion,
              source.depth + 1,
              source.rootParentId,
              root.node.parent_id,
              now,
            ],
          },
          {
            sql: `WITH RECURSIVE ancestry(node_id,parent_id,depth,path) AS (
              SELECT node.id,node.parent_id,0,'/'||node.id||'/'
              FROM nodes node WHERE node.id=?
              UNION ALL
              SELECT parent.id,parent.parent_id,ancestry.depth+1,ancestry.path||parent.id||'/'
              FROM ancestry
              JOIN nodes parent ON parent.id=ancestry.parent_id
              WHERE ancestry.node_id<>? AND ancestry.depth<64
                AND instr(ancestry.path,'/'||parent.id||'/')=0
            )
            INSERT INTO share_delegation_ancestry(share_id,node_id,parent_id,depth)
            SELECT ?,node_id,parent_id,depth FROM ancestry
            WHERE depth<=(SELECT depth FROM ancestry WHERE node_id=?)`,
            values: [root.node.id, source.rootNodeId, id, source.rootNodeId],
          },
          {
            sql: "INSERT INTO share_delegation_status(share_id,valid) VALUES(?,1)",
            values: [id],
          },
          {
            sql: `INSERT INTO share_reshare_requests(
              id,credential_id,request_digest,source_share_id,share_id,epoch,created_at
            ) VALUES(?,?,?,?,?,?,?)`,
            values: [
              requestIdentity!.id,
              session.credential_id,
              requestIdentity!.digest,
              source.id,
              id,
              session.epoch,
              now,
            ],
          },
        ]
      : []),
  ]);
  return source
    ? readReshareResult(env.DB, session, requestIdentity!.id, id)
    : readShare(env.DB, session, id);
}

async function readReshareResult(
  db: D1Database,
  session: AccessSession,
  requestId: string,
  shareId: string,
) {
  const assertions = currentAccess(session);
  await atomicBatch(db, assertions);
  const row = await primary(db)
    .prepare(`${SHARE_SELECT}
      JOIN share_reshare_requests request ON request.share_id=sh.id
      JOIN current_internal_shares current ON current.share_id=sh.id
      WHERE sh.id=? AND request.id=? AND request.credential_id=? AND request.epoch=?`)
    .bind(shareId, requestId, session.credential_id, session.epoch)
    .first<ShareRow>();
  if (!row) throw new Error("share_source_not_found");
  await atomicBatch(db, assertions);
  return output(row);
}

interface ManagedInternalShare {
  readonly rootNodeId: string;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly sourceShareId: string | null;
  readonly delegatedByUserId: string | null;
  readonly currentActions: string;
  readonly sourceActions: string | null;
  readonly policyActions: string | null;
}

async function managedInternalShare(
  db: D1Database,
  session: AccessSession,
  shareId: string,
): Promise<ManagedInternalShare> {
  const row = await primary(db)
    .prepare(`SELECT sh.root_node_id AS rootNodeId,root.space_id AS spaceId,
      sh.owner_id AS ownerId,delegation.source_share_id AS sourceShareId,
      delegation.delegated_by_user_id AS delegatedByUserId,
      (SELECT json_group_array(action) FROM (
        SELECT action FROM share_actions WHERE share_id=sh.id ORDER BY action
      )) AS currentActions,
      CASE WHEN delegation.share_id IS NULL THEN NULL ELSE (
        SELECT json_group_array(action) FROM (
          SELECT action FROM share_actions WHERE share_id=delegation.source_share_id
          ORDER BY action
        )
      ) END AS sourceActions,
      CASE WHEN delegation.share_id IS NULL THEN NULL ELSE (
        SELECT json_group_array(action) FROM (
          SELECT action FROM share_reshare_policy_actions
          WHERE share_id=delegation.policy_share_id ORDER BY action
        )
      ) END AS policyActions
    FROM shares sh
    JOIN nodes root ON root.id=sh.root_node_id AND root.owner_id=sh.owner_id
    JOIN current_internal_shares current ON current.share_id=sh.id
    LEFT JOIN share_delegations delegation ON delegation.share_id=sh.id
    WHERE sh.id=? AND sh.kind='internal'
      AND (sh.owner_id=? OR delegation.delegated_by_user_id=?)`)
    .bind(shareId, session.user_id, session.user_id)
    .first<ManagedInternalShare>();
  if (!row) throw new Error("share_not_found");
  return row;
}

async function readManagedShare(db: D1Database, session: AccessSession, shareId: string) {
  const assertions = currentAccess(session);
  await atomicBatch(db, assertions);
  const row = await primary(db)
    .prepare(`${SHARE_SELECT}
      JOIN current_internal_shares current ON current.share_id=sh.id
      LEFT JOIN share_delegations managed_delegation ON managed_delegation.share_id=sh.id
      WHERE sh.id=? AND sh.kind='internal'
        AND (sh.owner_id=? OR managed_delegation.delegated_by_user_id=?)`)
    .bind(shareId, session.user_id, session.user_id)
    .first<ShareRow>();
  if (!row) throw new Error("share_not_found");
  await atomicBatch(db, assertions);
  return output(row);
}

export async function updateInternalShare(
  env: Env,
  session: AccessSession,
  shareId: string,
  input: UpdateInternalShareInput,
) {
  if (!ID.test(shareId)) throw new Error("share_not_found");
  if (
    !input ||
    (input.actions === undefined && input.resharePolicy === undefined) ||
    Object.keys(input).some((key) => !["actions", "resharePolicy"].includes(key))
  )
    throw new Error("invalid_share_request");
  const actions = input.actions === undefined ? undefined : validatedActions(input.actions);
  const policyInput = validatedPolicy(input.resharePolicy);
  const row = await managedInternalShare(env.DB, session, shareId);
  if (policyInput !== undefined && (row.ownerId !== session.user_id || row.sourceShareId !== null))
    throw new Error("share_not_found");
  if (actions && row.sourceShareId !== null) {
    const currentActions = canonicalActions(JSON.parse(row.currentActions) as string[]);
    const sourceActions = canonicalActions(JSON.parse(row.sourceActions!) as string[]);
    const policyActions = canonicalActions(JSON.parse(row.policyActions!) as string[]);
    if (
      actions.some(
        (action) =>
          !currentActions.includes(action) ||
          !sourceActions.includes(action) ||
          !policyActions.includes(action),
      )
    )
      throw new Error("share_authority_exceeded");
  }
  let root;
  try {
    root = await authorizeNode(
      env.DB,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      { operation: "node.read", nodeId: row.rootNodeId, spaceId: row.spaceId },
    );
  } catch {
    throw new Error("share_not_found");
  }
  const admission = await acquireAccountMutation(env, row.ownerId, session.epoch, "share.update");
  const clock = "strftime('%s','now')*1000";
  const now = Date.now();
  const policyExpiresAt =
    policyInput?.ttlDays === undefined ? null : now + policyInput.ttlDays * DAY_MS;
  const currentShare = await primary(env.DB)
    .prepare(`SELECT sh.expires_at AS expiresAt,
      (SELECT json_group_array(action) FROM (
        SELECT action FROM share_actions WHERE share_id=sh.id ORDER BY action
      )) AS actions
      FROM shares sh WHERE sh.id=?`)
    .bind(shareId)
    .first<{ expiresAt: number | null; actions: string }>();
  if (
    policyInput &&
    (policyInput.actions.some(
      (action) =>
        !(actions ?? canonicalActions(JSON.parse(currentShare!.actions) as string[])).includes(
          action,
        ),
    ) ||
      (policyExpiresAt !== null &&
        currentShare?.expiresAt !== null &&
        currentShare?.expiresAt !== undefined &&
        policyExpiresAt > currentShare.expiresAt))
  )
    throw new Error("invalid_share_request");
  const actionStatements: SqlStatement[] =
    actions === undefined
      ? []
      : [
          { sql: "DELETE FROM share_actions WHERE share_id=?", values: [shareId] },
          ...actions.map((action) => ({
            sql: "INSERT INTO share_actions(share_id,action) VALUES(?,?)",
            values: [shareId, action],
          })),
          {
            sql: "UPDATE shares SET version=version+1 WHERE id=? AND owner_id=? AND kind='internal'",
            values: [shareId, row.ownerId],
          },
          {
            sql: "UPDATE share_grants SET version=(SELECT version FROM shares WHERE id=?) WHERE share_id=?",
            values: [shareId, shareId],
          },
          ...(policyInput === undefined
            ? [
                {
                  sql: `UPDATE share_reshare_policies SET version=version+1,updated_at=?
                    WHERE share_id=? AND EXISTS(
                      SELECT 1 FROM share_reshare_policy_actions
                      WHERE share_id=? AND action NOT IN (${actions.map(() => "?").join(",")})
                    )`,
                  values: [now, shareId, shareId, ...actions],
                },
                {
                  sql: `DELETE FROM share_reshare_policy_actions
                    WHERE share_id=? AND action NOT IN (${actions.map(() => "?").join(",")})`,
                  values: [shareId, ...actions],
                },
              ]
            : []),
          ...descendantRevocationStatements(shareId),
        ];
  const existingPolicy = await primary(env.DB)
    .prepare("SELECT version FROM share_reshare_policies WHERE share_id=?")
    .bind(shareId)
    .first<number>("version");
  const policyStatements: SqlStatement[] =
    policyInput === undefined
      ? []
      : existingPolicy === null
        ? [
            {
              sql: `INSERT INTO share_reshare_policies(
                share_id,enabled,max_depth,max_fanout,expires_at,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,?)`,
              values: [
                shareId,
                policyInput.enabled ? 1 : 0,
                policyInput.maxDepth,
                policyInput.maxFanout,
                policyExpiresAt,
                now,
                now,
              ],
            },
            ...policyInput.actions.map((action) => ({
              sql: "INSERT INTO share_reshare_policy_actions(share_id,action) VALUES(?,?)",
              values: [shareId, action],
            })),
          ]
        : [
            { sql: "DELETE FROM share_reshare_policy_actions WHERE share_id=?", values: [shareId] },
            ...policyInput.actions.map((action) => ({
              sql: "INSERT INTO share_reshare_policy_actions(share_id,action) VALUES(?,?)",
              values: [shareId, action],
            })),
            {
              sql: `UPDATE share_reshare_policies
                SET version=version+1,enabled=?,max_depth=?,max_fanout=?,expires_at=?,updated_at=?
                WHERE share_id=? AND version=?`,
              values: [
                policyInput.enabled ? 1 : 0,
                policyInput.maxDepth,
                policyInput.maxFanout,
                policyExpiresAt,
                now,
                shareId,
                existingPolicy,
              ],
            },
            ...descendantRevocationStatements(shareId),
          ];
  await commitAccountMutation(env.DB, admission, row.ownerId, [
    ...currentAccess(session),
    authorizationAssertion(root),
    assertExists(
      `SELECT 1 FROM current_internal_shares current
        JOIN shares sh ON sh.id=current.share_id
        LEFT JOIN share_delegations delegation ON delegation.share_id=sh.id
        WHERE sh.id=? AND sh.owner_id=? AND sh.kind='internal'
          AND sh.root_node_id=? AND sh.disabled_at IS NULL
          AND (sh.expires_at IS NULL OR sh.expires_at>${clock})
          AND (sh.owner_id=? OR delegation.delegated_by_user_id=?)`,
      [shareId, row.ownerId, row.rootNodeId, session.user_id, session.user_id],
    ),
    ...actionStatements,
    ...policyStatements,
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
  return readManagedShare(env.DB, session, shareId);
}

export async function updateInternalShareActions(
  env: Env,
  session: AccessSession,
  shareId: string,
  actions: readonly string[],
) {
  return updateInternalShare(env, session, shareId, { actions });
}

export async function listSharedWithMe(db: D1Database, session: AccessSession) {
  const result = await atomicBatch(db, [
    ...currentAccess(session),
    {
      sql: `WITH RECURSIVE recipient_share(
        shareId,provenanceKind,recipientVersion,groupId,groupName,groupVersion,membershipVersion
      ) AS (
        SELECT g.share_id,'direct',g.version,NULL,NULL,NULL,NULL
        FROM share_grants g JOIN shares direct ON direct.id=g.share_id
        WHERE g.user_id=? AND g.disabled_at IS NULL AND g.version=direct.version
        UNION
        SELECT gg.share_id,'group',NULL,sg.id,sg.name,sg.version,gm.version
        FROM share_group_grants gg
        JOIN share_groups sg ON sg.id=gg.group_id AND sg.disabled_at IS NULL
        JOIN shares grouped ON grouped.id=gg.share_id AND grouped.owner_id=sg.owner_id
        JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=?
          AND gm.disabled_at IS NULL
        JOIN users member ON member.id=gm.user_id AND member.disabled_at IS NULL
      ), live_share(
        shareId,shareVersion,mountName,rootId,spaceId,ownerId,rootName,rootKind,rootRevision,
        ownerEmail,provenanceKind,recipientVersion,groupId,groupName,groupVersion,membershipVersion,
        depth,path,currentId,currentKind,parentId,deletedAt
      ) AS (
        SELECT sh.id,sh.version,sh.mount_name,n.id,n.space_id,n.owner_id,n.name,n.kind,n.revision,
          owner.email,recipient.provenanceKind,recipient.recipientVersion,recipient.groupId,
          recipient.groupName,recipient.groupVersion,recipient.membershipVersion,
          0,'/'||n.id||'/',n.id,n.kind,n.parent_id,n.deleted_at
        FROM recipient_share recipient
        JOIN shares sh ON sh.id=recipient.shareId
        JOIN current_internal_shares current
          ON current.share_id=sh.id AND current.version=sh.version
        JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
        JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=? AND ctl.maintenance=0
        WHERE sh.kind='internal' AND sh.mount_name IS NOT NULL AND sh.disabled_at IS NULL
          AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
          AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='read')
        UNION ALL
        SELECT a.shareId,a.shareVersion,a.mountName,a.rootId,a.spaceId,a.ownerId,a.rootName,
          a.rootKind,a.rootRevision,a.ownerEmail,a.provenanceKind,a.recipientVersion,
          a.groupId,a.groupName,a.groupVersion,a.membershipVersion,a.depth+1,a.path||p.id||'/',
          p.id,p.kind,p.parent_id,p.deleted_at
        FROM live_share a JOIN nodes p ON p.id=a.parentId
        WHERE a.depth<64 AND p.space_id=a.spaceId AND p.owner_id=a.ownerId
          AND instr(a.path,'/'||p.id||'/')=0
      )
      SELECT a.shareId,a.shareVersion,a.mountName,a.rootId,a.spaceId,a.ownerId,a.rootName,
        a.rootKind,a.rootRevision,a.ownerEmail,a.provenanceKind,a.recipientVersion,
        a.groupId,a.groupName,a.groupVersion,a.membershipVersion,
        (SELECT json_group_array(action) FROM (
          SELECT action FROM share_actions WHERE share_id=a.shareId ORDER BY action
        )) AS actions
      FROM live_share a JOIN spaces sp ON sp.id=a.spaceId AND sp.owner_id=a.ownerId
      GROUP BY a.shareId
      HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deletedAt IS NULL)=1
        AND SUM(a.currentKind='root' AND a.parentId IS NULL AND a.currentId=sp.root_node_id)=1
      ORDER BY a.mountName,a.shareId LIMIT 100`,
      values: [session.user_id, session.user_id, session.epoch],
    },
  ]);
  return (result.at(-1)?.results ?? []).map((raw) => {
    const row = raw as {
      shareId: string;
      shareVersion: number;
      mountName: string;
      rootId: string;
      spaceId: string;
      ownerId: string;
      rootName: string;
      rootKind: "folder";
      rootRevision: number;
      ownerEmail: string;
      provenanceKind: "direct" | "group";
      recipientVersion: number | null;
      groupId: string | null;
      groupName: string | null;
      groupVersion: number | null;
      membershipVersion: number | null;
      actions: string;
    };
    return Object.freeze({
      shareId: row.shareId,
      shareVersion: row.shareVersion,
      mountId: row.shareId,
      mountName: row.mountName,
      actions: canonicalActions(JSON.parse(row.actions) as string[]),
      root: {
        id: row.rootId,
        spaceId: row.spaceId,
        ownerId: row.ownerId,
        name: row.rootName,
        kind: row.rootKind,
        revision: row.rootRevision,
      },
      owner: { id: row.ownerId, email: row.ownerEmail },
      provenance:
        row.provenanceKind === "group"
          ? {
              kind: "group" as const,
              groupId: row.groupId!,
              groupName: row.groupName!,
              groupVersion: row.groupVersion!,
              membershipVersion: row.membershipVersion!,
            }
          : {
              kind: "direct" as const,
              recipientVersion: row.recipientVersion!,
            },
    });
  });
}

export async function createShare(
  env: Env,
  session: AccessSession,
  input: CreateShareInput,
  passwordRing?: SharePasswordPepperRing,
  signal?: AbortSignal,
) {
  const kind = input.kind ?? "link";
  const reservationLimit =
    kind === "upload_only" ? (input.reservationLimitBytes ?? DEFAULT_UPLOAD_LIMIT) : 0;
  if (
    !ID.test(input.rootNodeId) ||
    !ID.test(input.spaceId) ||
    !["link", "upload_only"].includes(kind) ||
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365)) ||
    (input.password !== undefined && typeof input.password !== "string") ||
    (input.reservationLimitBytes !== undefined &&
      (kind !== "upload_only" ||
        !Number.isSafeInteger(input.reservationLimitBytes) ||
        input.reservationLimitBytes < 1 ||
        input.reservationLimitBytes > MAX_UPLOAD_LIMIT))
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
  if (kind === "upload_only" && !["root", "folder"].includes(root.node.kind))
    throw new Error("share_root_not_found");
  const active = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM shares WHERE owner_id=? AND kind IN ('link','upload_only')
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
      `SELECT 1 WHERE (SELECT COUNT(*) FROM shares WHERE owner_id=? AND kind IN ('link','upload_only')
        AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000))<?`,
      [session.user_id, ACTIVE_SHARE_LIMIT],
    ),
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,secret_digest,password_digest,salt,kdf,kdf_params,kid,
        expires_at,created_at,reservation_limit
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      values: [
        id,
        session.user_id,
        root.node.id,
        kind,
        secretDigest,
        passwordRecord?.passwordDigest ?? null,
        passwordRecord?.salt ?? null,
        passwordRecord?.kdf ?? null,
        passwordRecord?.kdfParams ?? null,
        passwordRecord?.kid ?? null,
        expiresAt,
        now,
        reservationLimit,
      ],
    },
    kind === "link"
      ? {
          sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read'),(?,'download')",
          values: [id, id],
        }
      : {
          sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'create'),(?,'upload')",
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
    .prepare(
      "SELECT kind,owner_id AS ownerId FROM shares WHERE id=? AND kind IN ('link','upload_only','internal')",
    )
    .bind(shareId)
    .first<{ kind: ShareRow["kind"]; ownerId: string }>();
  if (!exists) throw new Error("share_not_found");
  const managed =
    exists.kind === "internal"
      ? await managedInternalShare(env.DB, session, shareId)
      : exists.ownerId === session.user_id
        ? undefined
        : null;
  if (managed === null) throw new Error("share_not_found");
  const ownerId = managed?.ownerId ?? exists.ownerId;
  const admission = await acquireAccountMutation(env, ownerId, session.epoch, "share.disable");
  const clock = "strftime('%s','now')*1000";
  await commitAccountMutation(env.DB, admission, ownerId, [
    ...currentAccess(session),
    assertExists(
      exists.kind === "internal"
        ? `SELECT 1 FROM current_internal_shares current
          JOIN shares sh ON sh.id=current.share_id
          LEFT JOIN share_delegations delegation ON delegation.share_id=sh.id
          WHERE sh.id=? AND sh.owner_id=? AND sh.kind='internal'
            AND (sh.owner_id=? OR delegation.delegated_by_user_id=?)`
        : "SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind IN ('link','upload_only')",
      exists.kind === "internal"
        ? [shareId, ownerId, session.user_id, session.user_id]
        : [shareId, ownerId],
    ),
    {
      sql: `UPDATE shares SET disabled_at=COALESCE(disabled_at,${clock}),
        version=CASE WHEN disabled_at IS NULL THEN version+1 ELSE version END
        WHERE id=? AND owner_id=? AND kind IN ('link','upload_only','internal')`,
      values: [shareId, ownerId],
    },
    {
      sql: `UPDATE share_grants SET disabled_at=COALESCE(disabled_at,${clock})
        WHERE share_id=?`,
      values: [shareId],
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
    ...(exists.kind === "internal" ? descendantRevocationStatements(shareId) : []),
  ]);
}
