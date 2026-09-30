import { portableName } from "@next-cloud-flare/shared/names";
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
}

interface ShareRow {
  id: string;
  kind: "link" | "upload_only" | "internal";
  rootNodeId: string | null;
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
}

interface ShareOutput {
  id: string;
  kind: ShareRow["kind"];
  rootNodeId: string | null;
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
        }
      : {
          reservedBytes: row.reservedBytes,
          reservationLimit: row.reservationLimit,
        }),
  };
}

function canonicalActions(actions: readonly string[]) {
  return ["read", "download"].filter((action) => actions.includes(action));
}

function orderedActions(kind: ShareRow["kind"], actions: readonly string[]) {
  return (kind === "upload_only" ? ["create", "upload"] : ["read", "download"]).filter((action) =>
    actions.includes(action),
  );
}

const SHARE_SELECT = `SELECT sh.id,sh.kind,sh.root_node_id AS rootNodeId,sh.version,
  sh.disabled_at AS disabledAt,sh.expires_at AS expiresAt,sh.created_at AS createdAt,
  sh.password_digest IS NOT NULL AS passwordProtected,sh.reserved_bytes AS reservedBytes,
  sh.reservation_limit AS reservationLimit,
  COALESCE((SELECT json_group_array(action) FROM (
    SELECT action FROM share_actions WHERE share_id=sh.id ORDER BY action
  )),'[]') AS actions,
  g.user_id AS recipientUserId,u.email AS recipientEmail,
  gg.group_id AS recipientGroupId,sg.name AS recipientGroupName,sh.mount_name AS mountName
  FROM shares sh
  LEFT JOIN share_grants g ON g.share_id=sh.id
  LEFT JOIN users u ON u.id=g.user_id
  LEFT JOIN share_group_grants gg ON gg.share_id=sh.id
  LEFT JOIN share_groups sg ON sg.id=gg.group_id`;

export async function listShares(db: D1Database, session: AccessSession) {
  const statements = currentAccess(session);
  await atomicBatch(db, statements);
  const rows = await primary(db)
    .prepare(`${SHARE_SELECT} WHERE sh.owner_id=? AND sh.kind IN ('link','upload_only','internal')
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
      WHERE sh.id=? AND sh.owner_id=? AND sh.kind IN ('link','upload_only','internal')`)
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
    actions.length > 2 ||
    actions.some((action) => !["read", "download"].includes(action)) ||
    new Set(actions).size !== actions.length ||
    (actions.includes("download") && !actions.includes("read"))
  )
    throw new Error("invalid_share_request");
  return canonicalActions(actions);
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
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365))
  )
    throw new Error("invalid_share_request");
  const actions = validatedActions(input.actions);
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
        .bind(input.recipientGroupId, session.user_id)
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
    root.node.owner_id !== session.user_id ||
    root.node.kind !== "folder"
  )
    throw new Error("share_root_not_found");
  const existing = recipient
    ? await primary(env.DB)
        .prepare(`SELECT 1 FROM shares sh JOIN share_grants g ON g.share_id=sh.id
          WHERE sh.owner_id=? AND sh.root_node_id=? AND sh.kind='internal'
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND g.user_id=? AND g.disabled_at IS NULL AND g.version=sh.version`)
        .bind(session.user_id, root.node.id, recipient.id)
        .first<number>()
    : await primary(env.DB)
        .prepare(`SELECT 1 FROM shares sh JOIN share_group_grants gg ON gg.share_id=sh.id
          JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
          WHERE sh.owner_id=? AND sh.root_node_id=? AND sh.kind='internal'
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND sg.id=? AND sg.disabled_at IS NULL`)
        .bind(session.user_id, root.node.id, recipientGroup!.id)
        .first<number>();
  if (existing !== null) throw new Error("share_exists");
  const active = await primary(env.DB)
    .prepare(`SELECT COUNT(*) AS count FROM shares WHERE owner_id=? AND kind='internal'
      AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000)`)
    .bind(session.user_id)
    .first<number>("count");
  if (active === null || active >= ACTIVE_SHARE_LIMIT) throw new Error("share_limit");
  const id = ulid();
  const mount = stableMountName(id, root.node.name);
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
          [recipientGroup!.id, session.user_id],
        ),
    assertExists(
      `SELECT 1 WHERE
        (SELECT COUNT(*) FROM shares WHERE owner_id=? AND kind='internal'
          AND disabled_at IS NULL
          AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000))<?
        AND NOT EXISTS(
          SELECT 1 FROM shares sh
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
        session.user_id,
        ACTIVE_SHARE_LIMIT,
        session.user_id,
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
      values: [id, session.user_id, root.node.id, expiresAt, now, mount.name, mount.nameCi],
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
  ]);
  return readShare(env.DB, session, id);
}

export async function updateInternalShareActions(
  env: Env,
  session: AccessSession,
  shareId: string,
  actionsInput: readonly string[],
) {
  if (!ID.test(shareId)) throw new Error("share_not_found");
  const actions = validatedActions(actionsInput);
  const row = await primary(env.DB)
    .prepare(`SELECT sh.root_node_id AS rootNodeId,s.id AS spaceId
      FROM shares sh JOIN nodes n ON n.id=sh.root_node_id
      JOIN spaces s ON s.id=n.space_id AND s.owner_id=sh.owner_id
      WHERE sh.id=? AND sh.owner_id=? AND sh.kind='internal'`)
    .bind(shareId, session.user_id)
    .first<{ rootNodeId: string; spaceId: string }>();
  if (!row) throw new Error("share_not_found");
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
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "share.update",
  );
  const clock = "strftime('%s','now')*1000";
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...currentAccess(session),
    authorizationAssertion(root),
    assertExists(
      `SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind='internal'
        AND root_node_id=? AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at>${clock})`,
      [shareId, session.user_id, row.rootNodeId],
    ),
    { sql: "DELETE FROM share_actions WHERE share_id=?", values: [shareId] },
    ...actions.map((action) => ({
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,?)",
      values: [shareId, action],
    })),
    {
      sql: "UPDATE shares SET version=version+1 WHERE id=? AND owner_id=? AND kind='internal'",
      values: [shareId, session.user_id],
    },
    {
      sql: "UPDATE share_grants SET version=(SELECT version FROM shares WHERE id=?) WHERE share_id=?",
      values: [shareId, shareId],
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
  return readShare(env.DB, session, shareId);
}

export async function listSharedWithMe(db: D1Database, session: AccessSession) {
  const result = await atomicBatch(db, [
    ...currentAccess(session),
    {
      sql: `WITH RECURSIVE recipient_share(shareId) AS (
        SELECT g.share_id FROM share_grants g JOIN shares direct ON direct.id=g.share_id
        WHERE g.user_id=? AND g.disabled_at IS NULL AND g.version=direct.version
        UNION
        SELECT gg.share_id FROM share_group_grants gg
        JOIN share_groups sg ON sg.id=gg.group_id AND sg.disabled_at IS NULL
        JOIN shares grouped ON grouped.id=gg.share_id AND grouped.owner_id=sg.owner_id
        JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=?
          AND gm.disabled_at IS NULL
        JOIN users member ON member.id=gm.user_id AND member.disabled_at IS NULL
      ), live_share(
        shareId,shareVersion,mountName,rootId,spaceId,ownerId,rootName,rootKind,rootRevision,
        ownerEmail,depth,path,currentId,currentKind,parentId,deletedAt
      ) AS (
        SELECT sh.id,sh.version,sh.mount_name,n.id,n.space_id,n.owner_id,n.name,n.kind,n.revision,
          owner.email,0,'/'||n.id||'/',n.id,n.kind,n.parent_id,n.deleted_at
        FROM recipient_share recipient
        JOIN shares sh ON sh.id=recipient.shareId
        JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
        JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=? AND ctl.maintenance=0
        WHERE sh.kind='internal' AND sh.mount_name IS NOT NULL AND sh.disabled_at IS NULL
          AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
          AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='read')
        UNION ALL
        SELECT a.shareId,a.shareVersion,a.mountName,a.rootId,a.spaceId,a.ownerId,a.rootName,
          a.rootKind,a.rootRevision,a.ownerEmail,a.depth+1,a.path||p.id||'/',
          p.id,p.kind,p.parent_id,p.deleted_at
        FROM live_share a JOIN nodes p ON p.id=a.parentId
        WHERE a.depth<64 AND p.space_id=a.spaceId AND p.owner_id=a.ownerId
          AND instr(a.path,'/'||p.id||'/')=0
      )
      SELECT a.shareId,a.shareVersion,a.mountName,a.rootId,a.spaceId,a.ownerId,a.rootName,
        a.rootKind,a.rootRevision,a.ownerEmail,
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
      "SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind IN ('link','upload_only','internal')",
    )
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
    assertExists(
      "SELECT 1 FROM shares WHERE id=? AND owner_id=? AND kind IN ('link','upload_only','internal')",
      [shareId, session.user_id],
    ),
    {
      sql: `UPDATE shares SET disabled_at=COALESCE(disabled_at,${clock}),
        version=CASE WHEN disabled_at IS NULL THEN version+1 ELSE version END
        WHERE id=? AND owner_id=? AND kind IN ('link','upload_only','internal')`,
      values: [shareId, session.user_id],
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
  ]);
}
