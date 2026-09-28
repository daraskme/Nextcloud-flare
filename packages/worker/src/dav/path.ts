import { type PortableName, portableName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { principalSelection } from "../auth/selectedShare";
import { assertExists, atomicBatch, primary } from "../db/primary";

const MAX_PATH_BYTES = 16_384;
const MAX_SEGMENTS = 64;
type UserPrincipal = Extract<Principal, { readonly user_id: string }>;

export interface DavPath {
  readonly segments: readonly PortableName[];
  readonly trailingSlash: boolean;
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
  if (raw === "") return { segments: [], trailingSlash };
  const parts = raw.split("/");
  if (parts.length > MAX_SEGMENTS + 2 || parts.some((part) => part === ""))
    throw new Error("invalid_dav_path");
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
      return portableName(decoded);
    } catch (error) {
      if (
        index === 0 &&
        error instanceof Error &&
        error.message === "reserved_name" &&
        /^shared$/i.test(decodeURIComponent(part))
      )
        return { name: "Shared", nameCi: "shared", hidden: false };
      throw new Error("invalid_dav_path");
    }
  });
  if (segments.length > MAX_SEGMENTS + (segments[0]?.nameCi === "shared" ? 2 : 0))
    throw new Error("invalid_dav_path");
  return { segments, trailingSlash };
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

export function isSharedDavPath(path: DavPath) {
  return path.segments[0]?.nameCi === "shared";
}

/** Bind one immutable mount/version before interpreting any descendant or mutation operand. */
export async function davPrincipalForPath(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const selected = principalSelection(principal);
  if (!isSharedDavPath(path)) {
    if (selected) throw new Error("dav_node_unavailable");
    return principal;
  }
  if (path.segments.length < 2) throw new Error("dav_node_unavailable");
  const mount = await primary(db)
    .prepare(`SELECT sh.id,sh.version FROM shares sh
    JOIN share_grants g ON g.share_id=sh.id AND g.user_id=? AND g.version=sh.version AND g.disabled_at IS NULL
    JOIN credentials cr ON cr.id=? AND cr.kind='app_password'
    JOIN app_passwords ap ON ap.id=cr.app_password_id AND ap.user_id=g.user_id AND ap.root_node_id IS NULL
    WHERE sh.kind='internal' AND sh.mount_name_ci=? AND sh.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
      AND ap.revoked_at IS NULL AND ap.expires_at>strftime('%s','now')*1000`)
    .bind(principal.user_id, principal.credential_id, path.segments[1]!.nameCi)
    .first<{ id: string; version: number }>();
  if (!mount || (selected && (selected.id !== mount.id || selected.version !== mount.version)))
    throw new Error("dav_node_unavailable");
  return Object.freeze({ ...principal, selected_share: Object.freeze(mount) });
}

const SHARED_PATH_CTE = `WITH RECURSIVE shared_root AS (
  SELECT n.* FROM app_passwords ap JOIN credentials cr ON cr.app_password_id=ap.id AND cr.kind='app_password'
    JOIN users recipient ON recipient.id=ap.user_id AND recipient.disabled_at IS NULL
    JOIN share_grants g ON g.user_id=ap.user_id AND g.disabled_at IS NULL
    JOIN shares sh ON sh.id=g.share_id AND sh.kind='internal' AND sh.version=g.version
    JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
    JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
    JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=?3 AND ctl.maintenance=0
    WHERE cr.id=?1 AND ap.user_id=?2 AND ap.root_node_id IS NULL AND ap.revoked_at IS NULL
      AND ap.expires_at>strftime('%s','now')*1000 AND sh.id=?5 AND sh.version=?6
      AND sh.mount_name_ci=?7 AND sh.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
), ancestry(id,parent_id,space_id,owner_id,kind,deleted_at,depth,visited) AS (
  SELECT id,parent_id,space_id,owner_id,kind,deleted_at,0,'/'||id||'/' FROM shared_root
  UNION ALL SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.visited||n.id||'/'
    FROM ancestry a JOIN nodes n ON n.id=a.parent_id AND n.space_id=a.space_id AND n.owner_id=a.owner_id
    WHERE a.depth<64 AND instr(a.visited,'/'||n.id||'/')=0
), path(depth,id,space_id,owner_id) AS (
  SELECT 0,n.id,n.space_id,n.owner_id FROM shared_root n WHERE EXISTS(
    SELECT COUNT(*) FROM ancestry a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=a.owner_id
    HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
      AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1)
  UNION ALL SELECT path.depth+1,n.id,n.space_id,n.owner_id FROM path JOIN nodes n
    ON n.parent_id=path.id AND n.space_id=path.space_id AND n.owner_id=path.owner_id AND n.deleted_at IS NULL
      AND n.name_ci=json_extract(?4,'$['||path.depth||']') WHERE path.depth<json_array_length(?4)
)`;
function pathQuery(principal: UserPrincipal, path: DavPath) {
  const share = principalSelection(principal),
    shared = isSharedDavPath(path);
  if (shared !== !!share || (shared && path.segments.length < 2))
    throw new Error("dav_node_unavailable");
  const names = JSON.stringify(path.segments.slice(shared ? 2 : 0).map((s) => s.nameCi));
  return {
    sql: shared ? SHARED_PATH_CTE : PATH_CTE,
    values: [
      principal.credential_id,
      principal.user_id,
      principal.epoch,
      names,
      ...(share ? [share.id, share.version, path.segments[1]!.nameCi] : []),
    ],
  };
}

/** Resolve a DAV path and reassert its mapping alongside current node authority. */
export async function resolveDavNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  principal = await davPrincipalForPath(db, principal, path);
  const row = await davPathRow(db, principal, path);
  try {
    const proof = await authorizeNode(db, principal, {
      operation: "node.read",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.read") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof));
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve PROPPATCH with write authority, including write-only app passwords. */
export async function resolveDavPropsNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  principal = await davPrincipalForPath(db, principal, path);
  const row = await davPathRow(db, principal, path);
  try {
    const proof = await authorizeNode(db, principal, {
      operation: "node.props.write",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.props.write") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof));
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve a MOVE source with write authority, including write-only app passwords. */
export async function resolveDavMoveNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  principal = await davPrincipalForPath(db, principal, path);
  const row = await davPathRow(db, principal, path);
  try {
    const proof = await authorizeNode(db, principal, {
      operation: "node.rename",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.rename") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof));
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

async function findDavPathRow(db: D1Database, principal: UserPrincipal, path: DavPath) {
  const { sql, values } = pathQuery(principal, path);
  const row = await primary(db)
    .prepare(`${sql} SELECT id,space_id AS spaceId FROM path WHERE depth=json_array_length(?4)`)
    .bind(...values)
    .first<{ id: string; spaceId: string }>();
  return row;
}

async function davPathRow(db: D1Database, principal: UserPrincipal, path: DavPath) {
  const row = await findDavPathRow(db, principal, path);
  if (!row) throw new Error("dav_node_unavailable");
  return row;
}

async function assertDavPath(
  db: D1Database,
  principal: UserPrincipal,
  path: DavPath,
  row: { readonly id: string; readonly spaceId: string },
  authority?: ReturnType<typeof authorizationAssertion>,
) {
  await atomicBatch(db, [
    ...(authority ? [authority] : []),
    davPathAssertion(principal, path, row),
  ]);
}

function davPathAssertion(
  principal: UserPrincipal,
  path: DavPath,
  row: { readonly id: string; readonly spaceId: string },
) {
  const { sql, values } = pathQuery(principal, path);
  return assertExists(
    `${sql} SELECT 1 FROM path WHERE depth=json_array_length(?4) AND id=?${values.length + 1} AND space_id=?${values.length + 2}`,
    [...values, row.id, row.spaceId],
  );
}

/** Resolve OPTIONS source with current credential/root checks but no content scope. */
export async function resolveDavCredentialPath(
  db: D1Database,
  principal: Principal,
  path: DavPath,
) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  principal = await davPrincipalForPath(db, principal, path);
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
  try {
    principal = await davPrincipalForPath(db, principal, path);
  } catch (error) {
    if (error instanceof Error && error.message === "dav_node_unavailable") return null;
    throw error;
  }
  const row = await findDavPathRow(db, principal, path);
  if (!row) return null;
  return Object.freeze({ ...row, assertion: davPathAssertion(principal, path, row) });
}

/** Resolve the target parent without requiring read scope on a write-only app password. */
export async function resolveDavCreateParent(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  principal = await davPrincipalForPath(db, principal, path);
  const row = await davPathRow(db, principal, path);
  try {
    const proof = await authorizeNode(db, principal, {
      operation: "node.create",
      parentId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.create") throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(proof));
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
  principal = await davPrincipalForPath(db, principal, path);
  const parentPath: DavPath = {
    segments: path.segments.slice(0, -1),
    trailingSlash: true,
  };
  const parent = await resolveDavCreateParent(db, principal, parentPath);
  const row = await findDavPathRow(db, principal, path);
  if (!row) return Object.freeze({ parent, target: null, name: path.segments.at(-1)! });
  try {
    const target = await authorizeNode(db, principal, {
      operation: "node.trash",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (target.operation !== "node.trash" || target.parentId !== parent.parent.id)
      throw new Error("dav_node_unavailable");
    await assertDavPath(db, principal, path, row, authorizationAssertion(target));
    return Object.freeze({ parent, target, name: path.segments.at(-1)! });
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Virtual Shared exists only for an unrooted, current app password. */
export function sharedDavCredentialQuery(principal: Principal, readScope = true) {
  if (principal.kind !== "app_password" || principalSelection(principal))
    throw new Error("dav_node_unavailable");
  return {
    sql: `SELECT 1 FROM credentials cr JOIN app_passwords ap ON ap.id=cr.app_password_id
    JOIN users u ON u.id=ap.user_id AND u.disabled_at IS NULL
    JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=?3 AND ctl.maintenance=0
    WHERE cr.id=?1 AND cr.kind='app_password' AND ap.user_id=?2 AND ap.root_node_id IS NULL
      AND ap.revoked_at IS NULL AND ap.expires_at>strftime('%s','now')*1000
      ${readScope ? "AND EXISTS(SELECT 1 FROM credential_scopes WHERE credential_id=cr.id AND scope='node:read')" : ""}`,
    values: [principal.credential_id, principal.user_id, principal.epoch],
  };
}
