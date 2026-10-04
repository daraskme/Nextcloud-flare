import { type PortableName, portableName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
  principalAuthorizationContext,
} from "../auth/authorize";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

const MAX_PATH_BYTES = 16_384;
const MAX_SEGMENTS = 64;
type UserPrincipal = Extract<Principal, { readonly user_id: string }>;

export interface DavPath {
  readonly segments: readonly PortableName[];
  readonly trailingSlash: boolean;
  readonly shared: boolean;
}

/** Decode each URL segment once; the Shared virtual mount is handled separately. */
export function parseDavPath(pathname: string): DavPath {
  if (
    typeof pathname !== "string" ||
    new TextEncoder().encode(pathname).byteLength > MAX_PATH_BYTES ||
    (pathname !== "/dav" && !pathname.startsWith("/dav/"))
  )
    throw new Error("invalid_dav_path");
  const trailingSlash = pathname.endsWith("/");
  const remainder = pathname === "/dav" ? "" : pathname.slice(5);
  const raw = remainder.replace(/\/$/, "");
  if (raw === "") return { segments: [], trailingSlash, shared: false };
  const parts = raw.split("/");
  if (parts.length > MAX_SEGMENTS || parts.some((part) => part === ""))
    throw new Error("invalid_dav_path");
  let shared = false;
  const segments = parts.map((part, index) => {
    try {
      const decoded = decodeURIComponent(part);
      if (
        decoded.includes("/") ||
        decoded.includes("\\") ||
        /%[0-9a-f]{2}/i.test(decoded) ||
        decoded === "." ||
        decoded === ".."
      )
        throw new Error("invalid_dav_path");
      if (index === 0 && /^shared$/i.test(decoded)) {
        shared = true;
        return Object.freeze({ name: "Shared", nameCi: "shared", hidden: false });
      }
      return portableName(decoded);
    } catch (error) {
      throw new Error("invalid_dav_path");
    }
  });
  if (shared && segments.length < 2) throw new Error("invalid_dav_path");
  return { segments, trailingSlash, shared };
}

const PATH_CTE = `WITH RECURSIVE path(depth,id,space_id,owner_id) AS (
  SELECT 0,n.id,n.space_id,n.owner_id
    FROM app_passwords ap
    JOIN credentials c ON c.app_password_id=ap.id AND c.kind='app_password'
    JOIN users u ON u.id=ap.user_id AND u.disabled_at IS NULL
    JOIN spaces sp ON sp.owner_id=u.id
    JOIN nodes n ON n.id=COALESCE(ap.root_node_id,sp.root_node_id)
      AND n.space_id=sp.id AND n.owner_id=u.id AND n.deleted_at IS NULL
    JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=?3 AND ctl.maintenance=0
    WHERE c.id=?1 AND ap.user_id=?2 AND ap.revoked_at IS NULL
      AND ap.expires_at>strftime('%s','now')*1000
  UNION ALL
  SELECT path.depth+1,n.id,n.space_id,n.owner_id
    FROM path JOIN nodes n ON n.parent_id=path.id AND n.space_id=path.space_id
      AND n.owner_id=path.owner_id AND n.deleted_at IS NULL
      AND n.name_ci=json_extract(?4,'$['||path.depth||']')
    WHERE path.depth<json_array_length(?4)
)`;

const SHARED_PATH_CTE = `WITH RECURSIVE path(
  depth,id,space_id,owner_id,share_id,share_version,recipient_kind,recipient_version,
  group_id,group_version,can_create,can_edit,can_delete
) AS (
  SELECT 2,n.id,n.space_id,n.owner_id,sh.id,sh.version,
    CASE WHEN g.share_id IS NOT NULL THEN 'direct' ELSE 'group' END,
    COALESCE(g.version,gm.version),sg.id,sg.version,
    EXISTS(SELECT 1 FROM share_actions a JOIN credential_scopes cs
      ON cs.credential_id=c.id AND cs.scope='node:create'
      WHERE a.share_id=sh.id AND a.action='create'),
    EXISTS(SELECT 1 FROM share_actions a JOIN credential_scopes cs
      ON cs.credential_id=c.id AND cs.scope='node:write'
      WHERE a.share_id=sh.id AND a.action='edit'),
    EXISTS(SELECT 1 FROM share_actions a JOIN credential_scopes cs
      ON cs.credential_id=c.id AND cs.scope='node:delete'
      WHERE a.share_id=sh.id AND a.action='edit')
    FROM app_passwords ap
    JOIN credentials c ON c.app_password_id=ap.id AND c.kind='app_password'
    JOIN users recipient ON recipient.id=ap.user_id AND recipient.disabled_at IS NULL
    JOIN shares sh ON sh.kind='internal'
      AND sh.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
      AND sh.mount_name_ci=json_extract(?4,'$[1]')
    JOIN current_internal_shares current
      ON current.share_id=sh.id AND current.version=sh.version
    JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
    JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id AND n.deleted_at IS NULL
    LEFT JOIN share_grants g ON g.share_id=sh.id AND g.user_id=recipient.id
      AND g.disabled_at IS NULL AND g.version=sh.version
    LEFT JOIN share_group_grants gg ON gg.share_id=sh.id
    LEFT JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
      AND sg.disabled_at IS NULL
    LEFT JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=recipient.id
      AND gm.disabled_at IS NULL
    JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=?3 AND ctl.maintenance=0
    WHERE c.id=?1 AND ap.user_id=?2 AND ap.revoked_at IS NULL
      AND ap.expires_at>strftime('%s','now')*1000
      AND EXISTS(SELECT 1 FROM credential_scopes cs
        WHERE cs.credential_id=c.id AND cs.scope='node:read')
      AND EXISTS(SELECT 1 FROM share_actions sa
        WHERE sa.share_id=sh.id AND sa.action=?5)
      AND (g.share_id IS NOT NULL OR gm.group_id IS NOT NULL)
      AND EXISTS(WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
        SELECT r.id,r.parent_id,r.space_id,r.owner_id,r.kind,r.deleted_at,0,'/'||r.id||'/'
        FROM nodes r WHERE r.id=sh.root_node_id AND r.owner_id=sh.owner_id
        UNION ALL
        SELECT p.id,p.parent_id,p.space_id,p.owner_id,p.kind,p.deleted_at,a.depth+1,
          a.path||p.id||'/'
        FROM nodes p JOIN a ON p.id=a.parent_id
        WHERE a.depth<64 AND p.space_id=a.space_id AND p.owner_id=a.owner_id
          AND instr(a.path,'/'||p.id||'/')=0
      ) SELECT 1 FROM a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=sh.owner_id
        GROUP BY sp.id HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
          AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1)
  UNION ALL
  SELECT path.depth+1,n.id,n.space_id,n.owner_id,path.share_id,path.share_version,
    path.recipient_kind,path.recipient_version,path.group_id,path.group_version,
    path.can_create,path.can_edit,path.can_delete
    FROM path JOIN nodes n ON n.parent_id=path.id AND n.space_id=path.space_id
      AND n.owner_id=path.owner_id AND n.deleted_at IS NULL
      AND n.name_ci=json_extract(?4,'$['||path.depth||']')
    WHERE path.depth<json_array_length(?4)
)`;

function pathCte(path: DavPath) {
  return path.shared ? SHARED_PATH_CTE : PATH_CTE;
}

type SharedDavAction = "read" | "download" | "create" | "edit";
interface DavPathRow {
  readonly id: string;
  readonly spaceId: string;
  readonly shareId?: string;
  readonly shareVersion?: number;
  readonly recipientKind?: "direct" | "group";
  readonly recipientVersion?: number;
  readonly groupId?: string | null;
  readonly groupVersion?: number | null;
  readonly canCreate?: number;
  readonly canEdit?: number;
  readonly canDelete?: number;
}

const readAssertions = new WeakMap<AuthorizedNode, SqlStatement>();
const readCapabilities = new WeakMap<
  AuthorizedNode,
  Readonly<{ canCreate: boolean; canEdit: boolean; canDelete: boolean }>
>();

function sharedPrincipal(principal: UserPrincipal, row: DavPathRow): Principal {
  if (
    principal.kind !== "app_password" ||
    !row.shareId ||
    !Number.isSafeInteger(row.shareVersion) ||
    !row.recipientKind ||
    !Number.isSafeInteger(row.recipientVersion)
  )
    throw new Error("dav_node_unavailable");
  if (row.recipientKind === "group" && (!row.groupId || !Number.isSafeInteger(row.groupVersion)))
    throw new Error("dav_node_unavailable");
  return Object.freeze({
    ...principal,
    internal_share: {
      share_id: row.shareId,
      share_version: row.shareVersion!,
      recipient:
        row.recipientKind === "direct"
          ? { kind: "direct" as const, version: row.recipientVersion! }
          : {
              kind: "group" as const,
              group_id: row.groupId!,
              group_version: row.groupVersion!,
              membership_version: row.recipientVersion!,
            },
    },
  });
}

function pathPrincipal(principal: UserPrincipal, path: DavPath, row: DavPathRow): Principal {
  return path.shared ? sharedPrincipal(principal, row) : principal;
}

function pathValues(principal: UserPrincipal, path: DavPath, action: SharedDavAction) {
  const names = JSON.stringify(path.segments.map((segment) => segment.nameCi));
  const values: (string | number)[] = [
    principal.credential_id,
    principal.user_id,
    principal.epoch,
    names,
  ];
  if (path.shared) values.push(action);
  return values;
}

/** Resolve a personal DAV path and reassert its mapping alongside current node authority. */
export async function resolveDavNode(
  db: D1Database,
  principal: Principal,
  path: DavPath,
  sharedAction: SharedDavAction = "read",
) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await davPathRow(db, principal, path, sharedAction);
  try {
    const proof = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.read",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.read") throw new Error("dav_node_unavailable");
    const pathAssertion = davPathAssertion(principal, path, row, sharedAction);
    await atomicBatch(db, [authorizationAssertion(proof), pathAssertion]);
    if (path.shared) {
      readAssertions.set(proof, pathAssertion);
      readCapabilities.set(
        proof,
        Object.freeze({
          canCreate: row.canCreate === 1,
          canEdit: row.canEdit === 1,
          canDelete: row.canDelete === 1,
        }),
      );
    }
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve PROPPATCH with write authority, including write-only app passwords. */
export async function resolveDavPropsNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await davPathRow(db, principal, path, "edit");
  try {
    const proof = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.props.write",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.props.write") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof), "edit");
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve a MOVE source with write authority, including write-only app passwords. */
export async function resolveDavMoveNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await davPathRow(db, principal, path, "edit");
  try {
    const proof = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.rename",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.rename") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof), "edit");
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve a DELETE target with exact editable-share authority. */
export async function resolveDavTrashNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await davPathRow(db, principal, path, "edit");
  try {
    const proof = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.trash",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.trash") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof), "edit");
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

async function findDavPathRow(
  db: D1Database,
  principal: UserPrincipal,
  path: DavPath,
  sharedAction: SharedDavAction = "read",
) {
  const values = pathValues(principal, path, sharedAction);
  const row = await primary(db)
    .prepare(
      `${pathCte(path)} SELECT id,space_id AS spaceId${
        path.shared
          ? `,share_id AS shareId,share_version AS shareVersion,
            recipient_kind AS recipientKind,recipient_version AS recipientVersion,
            group_id AS groupId,group_version AS groupVersion,
            can_create AS canCreate,can_edit AS canEdit,can_delete AS canDelete`
          : ""
      } FROM path
        WHERE depth=json_array_length(?4)${
          path.shared
            ? " ORDER BY recipient_kind='direct' DESC,group_id,recipient_version LIMIT 1"
            : ""
        }`,
    )
    .bind(...values)
    .first<DavPathRow>();
  return row;
}

async function davPathRow(
  db: D1Database,
  principal: UserPrincipal,
  path: DavPath,
  sharedAction: SharedDavAction = "read",
) {
  const row = await findDavPathRow(db, principal, path, sharedAction);
  if (!row) throw new Error("dav_node_unavailable");
  return row;
}

async function assertDavPath(
  db: D1Database,
  principal: UserPrincipal,
  path: DavPath,
  row: DavPathRow,
  authority?: ReturnType<typeof authorizationAssertion>,
  sharedAction: SharedDavAction = "read",
) {
  await atomicBatch(db, [
    ...(authority ? [authority] : []),
    davPathAssertion(principal, path, row, sharedAction),
  ]);
}

function davPathAssertion(
  principal: UserPrincipal,
  path: DavPath,
  row: DavPathRow,
  sharedAction: SharedDavAction = "read",
) {
  const values = pathValues(principal, path, sharedAction);
  if (path.shared) {
    const shareVersion = row.shareVersion;
    if (!row.shareId || typeof shareVersion !== "number" || !Number.isSafeInteger(shareVersion))
      throw new Error("dav_node_unavailable");
    return assertExists(
      `${pathCte(path)} SELECT 1 FROM path
        WHERE depth=json_array_length(?4) AND id=?6 AND space_id=?7
          AND share_id=?8 AND share_version=?9 AND recipient_kind=?10
          AND recipient_version=?11 AND group_id IS ?12 AND group_version IS ?13
          AND can_create=?14 AND can_edit=?15 AND can_delete=?16`,
      [
        ...values,
        row.id,
        row.spaceId,
        row.shareId,
        shareVersion,
        row.recipientKind!,
        row.recipientVersion!,
        row.groupId ?? null,
        row.groupVersion ?? null,
        row.canCreate!,
        row.canEdit!,
        row.canDelete!,
      ],
    );
  }
  const idBinding = path.shared ? 6 : 5;
  const spaceBinding = idBinding + 1;
  return assertExists(
    `${pathCte(path)} SELECT 1 FROM path
      WHERE depth=json_array_length(?4) AND id=?${idBinding} AND space_id=?${spaceBinding}`,
    [...values, row.id, row.spaceId],
  );
}

export function davReadAssertion(authorized: AuthorizedNode) {
  const assertion = readAssertions.get(authorized);
  if (!assertion) throw new Error("invalid_dav_read_proof");
  return assertion;
}

export function davSharedCapabilities(authorized: AuthorizedNode) {
  return (
    readCapabilities.get(authorized) ??
    Object.freeze({ canCreate: false, canEdit: false, canDelete: false })
  );
}

export async function resolveDavSharedCapabilities(
  db: D1Database,
  principal: Principal,
  path: DavPath,
) {
  if (!path.shared) return Object.freeze({ canCreate: true, canEdit: true, canDelete: true });
  const mountPath: DavPath = {
    segments: path.segments.slice(0, 2),
    trailingSlash: true,
    shared: true,
  };
  const root = await resolveDavNode(db, principal, mountPath);
  return davSharedCapabilities(root);
}

/** Resolve OPTIONS source with current credential/root checks but no content scope. */
export async function resolveDavCredentialPath(
  db: D1Database,
  principal: Principal,
  path: DavPath,
) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  try {
    const row = await davPathRow(db, principal, path);
    await assertDavPath(db, principal, path, row);
    return row;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve condition resource state; an unmapped URL is null while storage failures propagate. */
export async function resolveDavConditionPath(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await findDavPathRow(db, principal, path);
  if (!row) return null;
  return Object.freeze({ ...row, assertion: davPathAssertion(principal, path, row) });
}

export function davConditionAbsentAssertion(principal: Principal, path: DavPath): SqlStatement {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  return {
    sql: `${pathCte(path)} INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(
      SELECT 1 FROM path WHERE depth=json_array_length(?4))`,
    values: pathValues(principal, path, "read"),
  };
}

/** Resolve the target parent without requiring read scope on a write-only app password. */
export async function resolveDavCreateParent(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const row = await davPathRow(db, principal, path, "create");
  try {
    const proof = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.create",
      parentId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.create") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof), "create");
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve a COPY/MOVE destination parent and an optional live overwrite target. */
export async function resolveDavTransferDestination(
  db: D1Database,
  principal: Principal,
  path: DavPath,
) {
  if (principal.kind !== "app_password" || path.segments.length === 0)
    throw new Error("dav_node_unavailable");
  const parentPath: DavPath = {
    segments: path.segments.slice(0, -1),
    trailingSlash: true,
    shared: path.shared,
  };
  const parent = await resolveDavCreateParent(db, principal, parentPath);
  const row = await findDavPathRow(db, principal, path, "edit");
  if (!row) return Object.freeze({ parent, target: null, name: path.segments.at(-1)! });
  try {
    const target = await authorizeNode(db, pathPrincipal(principal, path, row), {
      operation: "node.trash",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (target.operation !== "node.trash" || target.parentId !== parent.parent.id)
      throw new Error("dav_node_unavailable");
    if (
      principalAuthorizationContext(parent.principal) !==
      principalAuthorizationContext(target.principal)
    )
      throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(target), "edit");
    return Object.freeze({ parent, target, name: path.segments.at(-1)! });
  } catch {
    throw new Error("dav_node_unavailable");
  }
}
