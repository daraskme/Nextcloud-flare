import { type PortableName, portableName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
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
  if (parts.length > MAX_SEGMENTS || parts.some((part) => part === ""))
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
        throw new Error("dav_shared_not_ready");
      throw new Error("invalid_dav_path");
    }
  });
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

/** Resolve a personal DAV path and reassert its mapping alongside current node authority. */
export async function resolveDavNode(db: D1Database, principal: Principal, path: DavPath) {
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
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

async function findDavPathRow(db: D1Database, principal: UserPrincipal, path: DavPath) {
  const names = JSON.stringify(path.segments.map((segment) => segment.nameCi));
  const values = [principal.credential_id, principal.user_id, principal.epoch, names] as const;
  const row = await primary(db)
    .prepare(
      `${PATH_CTE} SELECT id,space_id AS spaceId FROM path WHERE depth=json_array_length(?4)`,
    )
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
  const names = JSON.stringify(path.segments.map((segment) => segment.nameCi));
  const values = [principal.credential_id, principal.user_id, principal.epoch, names] as const;
  return assertExists(
    `${PATH_CTE} SELECT 1 FROM path WHERE depth=json_array_length(?4) AND id=?5 AND space_id=?6`,
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
