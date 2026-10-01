import { type PortableName, portableName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
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

const SHARED_PATH_CTE = `WITH RECURSIVE path(depth,id,space_id,owner_id,share_id,share_version) AS (
  SELECT 2,n.id,n.space_id,n.owner_id,sh.id,sh.version
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
    JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=?3 AND ctl.maintenance=0
    WHERE c.id=?1 AND ap.user_id=?2 AND ap.revoked_at IS NULL
      AND ap.expires_at>strftime('%s','now')*1000
      AND EXISTS(SELECT 1 FROM credential_scopes cs
        WHERE cs.credential_id=c.id AND cs.scope='node:read')
      AND EXISTS(SELECT 1 FROM share_actions sa
        WHERE sa.share_id=sh.id AND sa.action=?5)
      AND (
        EXISTS(SELECT 1 FROM share_grants g
          WHERE g.share_id=sh.id AND g.user_id=recipient.id
            AND g.disabled_at IS NULL AND g.version=sh.version)
        OR EXISTS(
          SELECT 1 FROM share_group_grants gg
          JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
            AND sg.disabled_at IS NULL
          JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=recipient.id
            AND gm.disabled_at IS NULL
          WHERE gg.share_id=sh.id
        )
      )
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
  SELECT path.depth+1,n.id,n.space_id,n.owner_id,path.share_id,path.share_version
    FROM path JOIN nodes n ON n.parent_id=path.id AND n.space_id=path.space_id
      AND n.owner_id=path.owner_id AND n.deleted_at IS NULL
      AND n.name_ci=json_extract(?4,'$['||path.depth||']')
    WHERE path.depth<json_array_length(?4)
)`;

function pathCte(path: DavPath) {
  return path.shared ? SHARED_PATH_CTE : PATH_CTE;
}

type SharedDavAction = "read" | "download";
interface DavPathRow {
  readonly id: string;
  readonly spaceId: string;
  readonly shareId?: string;
  readonly shareVersion?: number;
}

const readAssertions = new WeakMap<AuthorizedNode, SqlStatement>();

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
    const proof = await authorizeNode(db, principal, {
      operation: "node.read",
      nodeId: row.id,
      spaceId: row.spaceId,
    });
    if (proof.operation !== "node.read") throw new Error("dav_node_unavailable");
    const pathAssertion = davPathAssertion(principal, path, row, sharedAction);
    await atomicBatch(db, [authorizationAssertion(proof), pathAssertion]);
    if (path.shared) readAssertions.set(proof, pathAssertion);
    return proof;
  } catch {
    throw new Error("dav_node_unavailable");
  }
}

/** Resolve PROPPATCH with write authority, including write-only app passwords. */
export async function resolveDavPropsNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
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
        path.shared ? ",share_id AS shareId,share_version AS shareVersion" : ""
      } FROM path
        WHERE depth=json_array_length(?4)`,
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
          AND share_id=?8 AND share_version=?9`,
      [...values, row.id, row.spaceId, row.shareId, shareVersion],
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

/** Resolve the target parent without requiring read scope on a write-only app password. */
export async function resolveDavCreateParent(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
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
  const parentPath: DavPath = {
    segments: path.segments.slice(0, -1),
    trailingSlash: true,
    shared: path.shared,
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
