import type { NodeSummary, ShareMode, ShareSummary, SharedMount } from "@ncf/shared";

import type { AuthenticatedUser } from "../auth/httpAuth.js";
import { randomToken, sha256 } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { derivePbkdf2, toHex } from "./kdf.js";

export type ShareAction = "read" | "download" | "upload";

interface ShareRow {
  id: string;
  ownerId: string;
  rootNodeId: string;
  version: number;
  actionsJson: string;
  kind: "link" | "user";
  linkSecretDigest: string | null;
  secretDigest: string | null;
  kdfParams: string | null;
  mountName: string;
  expiresAt: number | null;
  disabledAt: number | null;
  rootOwnerId: string;
  rootParentId: string | null;
  rootName: string;
  rootKind: "root" | "folder" | "file";
  rootRevision: number;
  rootBlobId: string | null;
  rootSize: number | null;
  rootMime: string | null;
  rootUpdatedAt: number;
  ownerRootId: string;
  granteeEmail: string | null;
}

export interface ShareCapability {
  id: string;
  ownerId: string;
  rootNodeId: string;
  version: number;
  kind: "link" | "user";
  mode: ShareMode;
  actions: ShareAction[];
  expiresAt: number | null;
  mountName: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

function actionsForMode(mode: ShareMode): ShareAction[] {
  if (mode === "upload") return ["upload"];
  if (mode === "download") return ["read", "download"];
  return ["read"];
}

function modeForActions(actions: readonly string[]): ShareMode {
  if (actions.includes("upload") && !actions.includes("read")) return "upload";
  return actions.includes("download") ? "download" : "view";
}

function parseActions(value: string): ShareAction[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("share_actions_invalid");
  const actions = parsed.filter(
    (action): action is ShareAction =>
      action === "read" || action === "download" || action === "upload",
  );
  if (actions.length !== parsed.length || actions.length === 0) {
    throw new Error("share_actions_invalid");
  }
  return actions;
}

function nodeSummary(row: ShareRow): NodeSummary {
  return {
    id: row.rootNodeId,
    parentId: row.rootParentId,
    name: row.rootName,
    kind: row.rootKind,
    revision: row.rootRevision,
    blobId: row.rootBlobId,
    size: row.rootSize,
    mime: row.rootMime,
    updatedAt: row.rootUpdatedAt,
  };
}

function summary(row: ShareRow, publicUrl?: string): ShareSummary {
  const actions = parseActions(row.actionsJson);
  return {
    id: row.id,
    kind: row.kind,
    mode: modeForActions(actions),
    root: nodeSummary(row),
    mountName: row.mountName,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
    passwordProtected: row.secretDigest !== null,
    granteeEmail: row.granteeEmail,
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

const shareSelect =
  "SELECT s.id,s.owner_id ownerId,s.root_node_id rootNodeId,s.version,s.actions_json actionsJson,s.kind,s.link_secret_digest linkSecretDigest,s.secret_digest secretDigest,s.kdf_params kdfParams,s.mount_name mountName,s.expires_at expiresAt,s.disabled_at disabledAt,n.owner_id rootOwnerId,n.parent_id rootParentId,n.name rootName,n.kind rootKind,n.revision rootRevision,n.current_blob_id rootBlobId,b.size rootSize,b.mime_sniffed rootMime,n.updated_at rootUpdatedAt,sp.root_node_id ownerRootId,(SELECT u.email FROM share_grants g JOIN users u ON u.id=g.grantee_user_id WHERE g.share_id=s.id AND g.revoked_at IS NULL LIMIT 1) granteeEmail FROM shares s JOIN nodes n ON n.id=s.root_node_id JOIN spaces sp ON sp.id=n.space_id LEFT JOIN blobs b ON b.id=n.current_blob_id";

async function passwordRecord(password: string | undefined): Promise<{
  digest: string | null;
  kdf: string | null;
  params: string | null;
  kid: string | null;
}> {
  if (password === undefined || password.length === 0) {
    return { digest: null, kdf: null, params: null, kid: null };
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  return {
    digest: toHex(await derivePbkdf2(password, salt, iterations)),
    kdf: "PBKDF2-HMAC-SHA256",
    params: JSON.stringify({ iterations, salt: Array.from(salt) }),
    kid: "share-password-v1",
  };
}

async function loadOwnerShare(env: Env, userId: string, shareId: string): Promise<ShareRow> {
  const row = await env.DB.prepare(`${shareSelect} WHERE s.id=?1 AND s.owner_id=?2`)
    .bind(shareId, userId)
    .first<ShareRow>();
  if (row === null) throw new Error("share_not_found");
  return row;
}

export async function createShare(
  env: Env,
  user: AuthenticatedUser,
  input: {
    rootNodeId: string;
    kind: "link" | "user";
    mode: ShareMode;
    expiresAt?: number | null;
    password?: string;
    granteeEmail?: string;
  },
): Promise<ShareSummary> {
  const now = Date.now();
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) {
    throw new RangeError("Share expiry must be in the future");
  }
  const root = await env.DB.prepare(
    "SELECT n.id,n.name,n.kind,n.owner_id ownerId,sp.root_node_id ownerRootId FROM nodes n JOIN spaces sp ON sp.id=n.space_id WHERE n.id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL",
  )
    .bind(input.rootNodeId, user.principal.userId)
    .first<{
      id: string;
      name: string;
      kind: "root" | "folder" | "file";
      ownerId: string;
      ownerRootId: string;
    }>();
  if (root === null || !(await isEffectiveLive(env, root.id, root.ownerRootId))) {
    throw new Error("node_not_found");
  }
  if (input.mode === "upload" && root.kind === "file") throw new Error("not_a_folder");
  const grantee =
    input.kind === "user"
      ? await env.DB.prepare(
          "SELECT id,email FROM users WHERE lower(email)=lower(?1) AND disabled_at IS NULL AND id<>?2",
        )
          .bind(input.granteeEmail ?? "", user.principal.userId)
          .first<{ id: string; email: string }>()
      : null;
  if (input.kind === "user" && grantee === null) throw new Error("share_recipient_not_found");
  const shareId = randomId("shr");
  const linkSecret = input.kind === "link" ? randomToken(32) : undefined;
  const password = await passwordRecord(input.password);
  const actions = actionsForMode(input.mode);
  const mountName = `${shareId.slice(-8)}-${root.name || "Shared"}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.kind='access' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
    ).bind(user.principal.sessionId, user.principal.userId),
    env.DB.prepare(
      "INSERT INTO shares(id,owner_id,root_node_id,version,actions_json,secret_digest,kdf,kdf_params,kid,expires_at,disabled_at,created_at,kind,link_secret_digest,mount_name) SELECT ?1,?2,?3,1,?4,?5,?6,?7,?8,?9,NULL,?10,?11,?12,?13 WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?3 AND owner_id=?2 AND deleted_at IS NULL)",
    ).bind(
      shareId,
      user.principal.userId,
      root.id,
      JSON.stringify(actions),
      password.digest,
      password.kdf,
      password.params,
      password.kid,
      input.expiresAt ?? null,
      now,
      input.kind,
      linkSecret === undefined ? null : await sha256(linkSecret),
      mountName,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ];
  if (grantee !== null) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO share_grants(id,share_id,grantee_user_id,actions_json,revoked_at) VALUES(?1,?2,?3,?4,NULL)",
      ).bind(randomId("grt"), shareId, grantee.id, JSON.stringify(actions)),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    );
  }
  await env.DB.batch(statements);
  const created = await loadOwnerShare(env, user.principal.userId, shareId);
  return summary(
    created,
    linkSecret === undefined
      ? undefined
      : `${env.APP_ORIGIN}/s/${encodeURIComponent(shareId)}#${linkSecret}`,
  );
}

export async function listShares(env: Env, userId: string): Promise<ShareSummary[]> {
  const rows = await env.DB.prepare(
    `${shareSelect} WHERE s.owner_id=?1 ORDER BY s.created_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all<ShareRow>();
  return rows.results.map((row) => summary(row));
}

export async function getShare(env: Env, userId: string, shareId: string): Promise<ShareSummary> {
  return summary(await loadOwnerShare(env, userId, shareId));
}

export async function updateShare(
  env: Env,
  user: AuthenticatedUser,
  shareId: string,
  input: { mode?: ShareMode; expiresAt?: number | null; password?: string | null },
): Promise<ShareSummary> {
  const current = await loadOwnerShare(env, user.principal.userId, shareId);
  const now = Date.now();
  const expiresAt = input.expiresAt === undefined ? current.expiresAt : input.expiresAt;
  if (expiresAt !== null && expiresAt <= now) throw new RangeError("Share expiry must be future");
  const actions =
    input.mode === undefined ? parseActions(current.actionsJson) : actionsForMode(input.mode);
  if (current.kind === "user" && input.mode === "upload") {
    throw new RangeError("Upload-only is link-only");
  }
  const password =
    input.password === undefined ? null : await passwordRecord(input.password ?? undefined);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE shares SET actions_json=?1,expires_at=?2,secret_digest=CASE WHEN ?3=0 THEN secret_digest ELSE ?4 END,kdf=CASE WHEN ?3=0 THEN kdf ELSE ?5 END,kdf_params=CASE WHEN ?3=0 THEN kdf_params ELSE ?6 END,kid=CASE WHEN ?3=0 THEN kid ELSE ?7 END,version=version+1 WHERE id=?8 AND owner_id=?9 AND disabled_at IS NULL",
    ).bind(
      JSON.stringify(actions),
      expiresAt,
      password === null ? 0 : 1,
      password?.digest ?? null,
      password?.kdf ?? null,
      password?.params ?? null,
      password?.kid ?? null,
      shareId,
      user.principal.userId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE share_grants SET actions_json=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(JSON.stringify(actions), shareId),
    env.DB.prepare(
      "UPDATE share_sessions SET revoked_at=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at=?1 WHERE id IN (SELECT id FROM share_sessions WHERE share_id=?2) AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE content_sessions SET revoked_at=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE content_tickets SET canceled_at=?1 WHERE share_id=?2 AND canceled_at IS NULL",
    ).bind(now, shareId),
  ]);
  return getShare(env, user.principal.userId, shareId);
}

export async function disableShare(
  env: Env,
  user: AuthenticatedUser,
  shareId: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE shares SET disabled_at=?1,version=version+1 WHERE id=?2 AND owner_id=?3 AND disabled_at IS NULL",
    ).bind(now, shareId, user.principal.userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE share_grants SET revoked_at=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE share_sessions SET revoked_at=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at=?1 WHERE id IN (SELECT id FROM share_sessions WHERE share_id=?2) AND revoked_at IS NULL",
    ).bind(now, shareId),
    env.DB.prepare(
      "UPDATE content_sessions SET revoked_at=?1 WHERE share_id=?2 AND revoked_at IS NULL",
    ).bind(now, shareId),
  ]);
}

export async function loadPublicShare(
  env: Env,
  shareId: string,
  now = Date.now(),
): Promise<ShareRow> {
  const row = await env.DB.prepare(`${shareSelect} WHERE s.id=?1 AND s.kind='link'`)
    .bind(shareId)
    .first<ShareRow>();
  if (row?.linkSecretDigest == null) throw new Error("share_not_found");
  if (row.disabledAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
    throw new Error("share_gone");
  }
  if (
    row.rootOwnerId !== row.ownerId ||
    !(await isEffectiveLive(env, row.rootNodeId, row.ownerRootId))
  ) {
    throw new Error("share_not_found");
  }
  return row;
}

export function capability(row: ShareRow): ShareCapability {
  return {
    id: row.id,
    ownerId: row.ownerId,
    rootNodeId: row.rootNodeId,
    version: row.version,
    kind: row.kind,
    mode: modeForActions(parseActions(row.actionsJson)),
    actions: parseActions(row.actionsJson),
    expiresAt: row.expiresAt,
    mountName: row.mountName,
  };
}

export async function verifySharePassword(
  row: ShareRow,
  password: string | undefined,
): Promise<boolean> {
  if (row.secretDigest === null) return true;
  if (password === undefined || row.kdfParams === null) return false;
  let params: { iterations?: unknown; salt?: unknown };
  try {
    params = JSON.parse(row.kdfParams) as { iterations?: unknown; salt?: unknown };
  } catch {
    return false;
  }
  if (
    params.iterations !== 100_000 ||
    !Array.isArray(params.salt) ||
    params.salt.length !== 16 ||
    !params.salt.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    return false;
  }
  return (
    toHex(await derivePbkdf2(password, Uint8Array.from(params.salt), 100_000)) === row.secretDigest
  );
}

export async function shareTreeBytes(env: Env, share: ShareCapability): Promise<number> {
  const row = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 AND deleted_at IS NULL UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND sub.depth<64 LIMIT 10001) SELECT COUNT(*) count,COALESCE(SUM(b.size),0) bytes FROM sub JOIN nodes n ON n.id=sub.id LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.state='committed'",
  )
    .bind(share.rootNodeId)
    .first<{ count: number; bytes: number }>();
  if (row === null || row.count > 10_000 || !Number.isSafeInteger(row.bytes)) {
    throw new Error("share_budget_exceeded");
  }
  return row.bytes;
}

export async function assertShareNode(
  env: Env,
  share: ShareCapability,
  nodeId: string,
  action: ShareAction,
): Promise<void> {
  if (!share.actions.includes(action)) throw new Error("share_action_forbidden");
  const row = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,deleted_at,depth,path) AS (SELECT id,parent_id,deleted_at,0,'/'||id||'/' FROM nodes WHERE id=?1 AND owner_id=?2 UNION ALL SELECT p.id,p.parent_id,p.deleted_at,a.depth+1,a.path||p.id||'/' FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND instr(a.path,'/'||p.id||'/')=0) SELECT COUNT(*) count,MIN(deleted_at IS NULL) live,MAX(id=?3) reachesRoot FROM a",
  )
    .bind(nodeId, share.ownerId, share.rootNodeId)
    .first<{ count: number; live: number; reachesRoot: number }>();
  if (row === null || row.count < 1 || row.count > 65 || row.live !== 1 || row.reachesRoot !== 1) {
    throw new Error("node_not_found");
  }
}

export async function getShareNode(
  env: Env,
  share: ShareCapability,
  nodeId: string,
): Promise<NodeSummary> {
  await assertShareNode(env, share, nodeId, "read");
  const row = await env.DB.prepare(
    "SELECT n.id,n.parent_id parentId,n.name,n.kind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.updated_at updatedAt FROM nodes n LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL",
  )
    .bind(nodeId, share.ownerId)
    .first<NodeSummary>();
  if (row === null) throw new Error("node_not_found");
  return row;
}

export async function getSharePath(
  env: Env,
  share: ShareCapability,
  nodeId: string,
): Promise<{ id: string; name: string }[]> {
  await assertShareNode(env, share, nodeId, "read");
  const rows = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,name,depth) AS (SELECT id,parent_id,name,0 FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL UNION ALL SELECT p.id,p.parent_id,p.name,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.id<>?3 AND a.depth<64 AND p.deleted_at IS NULL) SELECT id,name FROM a ORDER BY depth DESC",
  )
    .bind(nodeId, share.ownerId, share.rootNodeId)
    .all<{ id: string; name: string }>();
  if (rows.results[0]?.id !== share.rootNodeId) throw new Error("node_not_found");
  return rows.results.map((item, index) => ({
    id: item.id,
    name: index === 0 ? share.mountName : item.name,
  }));
}

export async function listShareChildren(
  env: Env,
  share: ShareCapability,
  parentId: string,
): Promise<NodeSummary[]> {
  await assertShareNode(env, share, parentId, "read");
  const parent = await env.DB.prepare(
    "SELECT kind FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL",
  )
    .bind(parentId, share.ownerId)
    .first<{ kind: string }>();
  if (parent?.kind !== "root" && parent?.kind !== "folder") throw new Error("not_a_folder");
  const rows = await env.DB.prepare(
    "SELECT n.id,n.parent_id parentId,n.name,n.kind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.updated_at updatedAt FROM nodes n LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL ORDER BY n.name_ci,n.id LIMIT 201",
  )
    .bind(parentId, share.ownerId)
    .all<NodeSummary>();
  if (rows.results.length > 200) throw new Error("share_listing_too_large");
  return rows.results;
}

export async function findInternalShare(
  env: Env,
  userId: string,
  nodeId: string,
  action: "read" | "download",
  now = Date.now(),
): Promise<ShareCapability | null> {
  const row = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,depth,path) AS (SELECT id,parent_id,0,'/'||id||'/' FROM nodes WHERE id=?1 AND deleted_at IS NULL UNION ALL SELECT p.id,p.parent_id,a.depth+1,a.path||p.id||'/' FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL AND instr(a.path,'/'||p.id||'/')=0) SELECT s.id,s.owner_id ownerId,s.root_node_id rootNodeId,s.version,s.actions_json actionsJson,s.kind,s.expires_at expiresAt,s.mount_name mountName FROM a JOIN shares s ON s.root_node_id=a.id JOIN share_grants g ON g.share_id=s.id JOIN users owner ON owner.id=s.owner_id WHERE g.grantee_user_id=?2 AND g.revoked_at IS NULL AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?3) AND owner.disabled_at IS NULL AND EXISTS(SELECT 1 FROM json_each(g.actions_json) WHERE value=?4) ORDER BY a.depth LIMIT 1",
  )
    .bind(nodeId, userId, now, action)
    .first<{
      id: string;
      ownerId: string;
      rootNodeId: string;
      version: number;
      actionsJson: string;
      kind: "user";
      expiresAt: number | null;
      mountName: string;
    }>();
  if (row === null) return null;
  const share: ShareCapability = {
    id: row.id,
    ownerId: row.ownerId,
    rootNodeId: row.rootNodeId,
    version: row.version,
    kind: row.kind,
    actions: parseActions(row.actionsJson),
    mode: modeForActions(parseActions(row.actionsJson)),
    expiresAt: row.expiresAt,
    mountName: row.mountName,
  };
  try {
    await assertShareNode(env, share, nodeId, action);
    return share;
  } catch {
    return null;
  }
}

export async function listSharedWithMe(env: Env, userId: string): Promise<SharedMount[]> {
  const rows = await env.DB.prepare(
    "SELECT s.id shareId,s.owner_id ownerId,s.root_node_id rootNodeId,s.version,s.actions_json actionsJson,s.kind,s.expires_at expiresAt,s.mount_name mountName,u.email ownerEmail,n.parent_id parentId,n.name,n.kind rootKind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.updated_at updatedAt,sp.root_node_id ownerRootId FROM share_grants g JOIN shares s ON s.id=g.share_id JOIN users u ON u.id=s.owner_id JOIN nodes n ON n.id=s.root_node_id JOIN spaces sp ON sp.id=n.space_id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE g.grantee_user_id=?1 AND g.revoked_at IS NULL AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>(strftime('%s','now')*1000)) AND u.disabled_at IS NULL ORDER BY s.created_at DESC LIMIT 200",
  )
    .bind(userId)
    .all<{
      shareId: string;
      ownerId: string;
      rootNodeId: string;
      version: number;
      actionsJson: string;
      kind: "user";
      expiresAt: number | null;
      mountName: string;
      ownerEmail: string;
      parentId: string | null;
      name: string;
      rootKind: "root" | "folder" | "file";
      revision: number;
      blobId: string | null;
      size: number | null;
      mime: string | null;
      updatedAt: number;
      ownerRootId: string;
    }>();
  const mounts: SharedMount[] = [];
  for (const row of rows.results) {
    if (!(await isEffectiveLive(env, row.rootNodeId, row.ownerRootId))) continue;
    mounts.push({
      shareId: row.shareId,
      mountName: row.mountName,
      ownerEmail: row.ownerEmail,
      mode: modeForActions(parseActions(row.actionsJson)),
      root: {
        id: row.rootNodeId,
        parentId: row.parentId,
        name: row.name,
        kind: row.rootKind,
        revision: row.revision,
        blobId: row.blobId,
        size: row.size,
        mime: row.mime,
        updatedAt: row.updatedAt,
      },
    });
  }
  return mounts;
}
