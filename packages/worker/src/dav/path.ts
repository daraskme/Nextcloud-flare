import type { AuthenticatedAppPassword } from "../auth/appPassword.js";
import type { Env } from "../env.js";
import { isEffectiveLive } from "../services/effectiveLive.js";
import { getOwnerWorkspace } from "../services/nodes.js";

export interface DavNode {
  id: string;
  ownerId: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  blobId: string | null;
  size: number | null;
  mime: string | null;
  createdAt: number;
  updatedAt: number;
  href: string;
  shared: boolean;
}

export interface DavMissingPath {
  parent: DavNode;
  name: string;
  href: string;
}

function decodePathname(url: URL): string[] {
  const encoded = url.pathname;
  if (!encoded.startsWith("/dav") || (encoded.length > 4 && encoded[4] !== "/")) {
    throw new RangeError("DAV path is invalid");
  }
  if (/%2f|%5c/iu.test(encoded) || /%(?![0-9A-Fa-f]{2})/u.test(encoded)) {
    throw new RangeError("DAV path is invalid");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded.slice(4));
  } catch {
    throw new RangeError("DAV path is invalid");
  }
  if (
    Array.from(decoded).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127 || character === "\\";
    }) ||
    /%[0-9A-Fa-f]{2}/u.test(decoded)
  ) {
    throw new RangeError("DAV path is invalid");
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.length > 64 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new RangeError("DAV path is invalid");
  }
  return segments;
}

function hrefFor(segments: readonly string[], collection = false): string {
  const path = `/dav${segments.length === 0 ? "/" : `/${segments.map(encodeURIComponent).join("/")}`}`;
  return collection && !path.endsWith("/") ? `${path}/` : path;
}

async function loadNode(env: Env, id: string, shared: boolean, href: string): Promise<DavNode> {
  const row = await env.DB.prepare(
    "SELECT n.id,n.owner_id ownerId,n.space_id spaceId,n.parent_id parentId,n.name,n.kind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.created_at createdAt,n.updated_at updatedAt,s.root_node_id ownerRootId FROM nodes n JOIN spaces s ON s.id=n.space_id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND n.deleted_at IS NULL",
  )
    .bind(id)
    .first<Omit<DavNode, "href" | "shared"> & { ownerRootId: string }>();
  if (row === null || !(await isEffectiveLive(env, row.id, row.ownerRootId))) {
    throw new Error("node_not_found");
  }
  return {
    ...row,
    href: row.kind === "file" ? href : href.endsWith("/") ? href : `${href}/`,
    shared,
  };
}

async function child(env: Env, parentId: string, name: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM nodes WHERE parent_id=?1 AND name_ci=?2 AND deleted_at IS NULL",
  )
    .bind(parentId, name.normalize("NFC").toLowerCase())
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function sharedRoot(
  env: Env,
  userId: string,
  mount: string,
): Promise<{ rootId: string; editable: boolean } | null> {
  const row = await env.DB.prepare(
    "SELECT s.root_node_id rootId,g.actions_json actionsJson FROM share_grants g JOIN shares s ON s.id=g.share_id WHERE g.grantee_user_id=?1 AND s.mount_name=?2 AND g.revoked_at IS NULL AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>(strftime('%s','now')*1000))",
  )
    .bind(userId, mount)
    .first<{ rootId: string; actionsJson: string }>();
  if (row === null) return null;
  const actions: unknown = JSON.parse(row.actionsJson);
  return { rootId: row.rootId, editable: Array.isArray(actions) && actions.includes("edit") };
}

export function parseDavUrl(requestUrl: string): { url: URL; segments: string[] } {
  const url = new URL(requestUrl);
  return { url, segments: decodePathname(url) };
}

export function validateDestination(value: string | null, appOrigin: string): URL {
  if (value === null || value.length > 16_384) throw new RangeError("Destination is required");
  let destination: URL;
  let origin: URL;
  try {
    destination = new URL(value);
    origin = new URL(appOrigin);
  } catch {
    throw new RangeError("Destination is invalid");
  }
  if (
    destination.protocol !== "https:" ||
    destination.origin !== origin.origin ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.search !== "" ||
    destination.hash !== ""
  ) {
    throw new RangeError("Destination is invalid");
  }
  decodePathname(destination);
  return destination;
}

export async function resolveDavPath(
  env: Env,
  authentication: AuthenticatedAppPassword,
  requestUrl: string,
  allowMissing = false,
): Promise<DavNode | DavMissingPath> {
  const { segments } = parseDavUrl(requestUrl);
  const workspace = await getOwnerWorkspace(env, authentication.principal.userId);
  const baseRoot = authentication.principal.rootNodeId ?? workspace.rootId;
  if (segments.length === 0) return loadNode(env, baseRoot, false, "/dav/");
  let rootId = baseRoot;
  let offset = 0;
  let shared = false;
  if (segments[0] === "Shared") {
    if (authentication.principal.rootNodeId !== null) throw new Error("node_not_found");
    if (segments.length === 1) {
      return {
        id: `shared-${authentication.principal.userId}`,
        ownerId: authentication.principal.userId,
        spaceId: workspace.spaceId,
        parentId: null,
        name: "Shared",
        kind: "folder",
        revision: 1,
        blobId: null,
        size: null,
        mime: null,
        createdAt: 0,
        updatedAt: 0,
        href: "/dav/Shared/",
        shared: true,
      };
    }
    const mountName = segments[1];
    if (mountName === undefined) throw new Error("node_not_found");
    const mount = await sharedRoot(env, authentication.principal.userId, mountName);
    if (mount === null) throw new Error("node_not_found");
    rootId = mount.rootId;
    offset = 2;
    shared = true;
  }
  let current = await loadNode(env, rootId, shared, hrefFor(segments.slice(0, offset), true));
  for (let index = offset; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new Error("node_not_found");
    if ((index === 0 && segment === "Shared") || segment.startsWith(".ncf-")) {
      throw new Error("node_not_found");
    }
    if (current.kind === "file") throw new Error("node_not_found");
    const id = await child(env, current.id, segment);
    if (id === null) {
      if (allowMissing && index === segments.length - 1 && !shared) {
        return { parent: current, name: segment, href: hrefFor(segments) };
      }
      throw new Error("node_not_found");
    }
    current = await loadNode(env, id, shared, hrefFor(segments.slice(0, index + 1)));
  }
  return current;
}

export async function listDavChildren(env: Env, parent: DavNode): Promise<DavNode[]> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) value FROM nodes WHERE parent_id=?1 AND deleted_at IS NULL",
  )
    .bind(parent.id)
    .first<{ value: number }>();
  if ((count?.value ?? 0) > 1000) throw new Error("dav_propfind_limit");
  const rows = await env.DB.prepare(
    "SELECT n.id,n.owner_id ownerId,n.space_id spaceId,n.parent_id parentId,n.name,n.kind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.created_at createdAt,n.updated_at updatedAt FROM nodes n LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id=?1 AND n.deleted_at IS NULL ORDER BY n.name_ci,n.id LIMIT 1001",
  )
    .bind(parent.id)
    .all<Omit<DavNode, "href" | "shared">>();
  const base = parent.href.endsWith("/") ? parent.href : `${parent.href}/`;
  return rows.results.map((row) => ({
    ...row,
    href: `${base}${encodeURIComponent(row.name)}${row.kind === "file" ? "" : "/"}`,
    shared: parent.shared,
  }));
}

export async function listSharedMounts(env: Env, userId: string): Promise<DavNode[]> {
  const rows = await env.DB.prepare(
    "SELECT n.id,n.owner_id ownerId,n.space_id spaceId,n.parent_id parentId,s.mount_name name,n.kind,n.revision,n.current_blob_id blobId,b.size,b.mime_sniffed mime,n.created_at createdAt,n.updated_at updatedAt FROM share_grants g JOIN shares s ON s.id=g.share_id JOIN nodes n ON n.id=s.root_node_id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE g.grantee_user_id=?1 AND g.revoked_at IS NULL AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>(strftime('%s','now')*1000)) AND n.deleted_at IS NULL ORDER BY s.mount_name LIMIT 1001",
  )
    .bind(userId)
    .all<Omit<DavNode, "href" | "shared">>();
  if (rows.results.length > 1000) throw new Error("dav_propfind_limit");
  return rows.results.map((row) => ({
    ...row,
    href: `/dav/Shared/${encodeURIComponent(row.name)}${row.kind === "file" ? "" : "/"}`,
    shared: true,
  }));
}

export function isMissingDavPath(value: DavNode | DavMissingPath): value is DavMissingPath {
  return "parent" in value;
}
