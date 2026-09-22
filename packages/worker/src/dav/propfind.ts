import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { DavPath } from "./path";
import { type DavPropertyName, type PropfindRequest, validateDavXmlFragment } from "./xml";

const DAV = "DAV:";
const MAX_CHILDREN = 1_000;
const MAX_RESPONSE_BYTES = 33_554_432;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/;

interface NodeRow {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  size: number | null;
  createdAt: number;
  updatedAt: number;
}
interface PropRow {
  nodeId: string;
  namespace: string;
  name: string;
  valueXml: string;
}

const LIVE = [
  "displayname",
  "getetag",
  "getcontentlength",
  "getlastmodified",
  "resourcetype",
  "lockdiscovery",
  "supportedlock",
  "creationdate",
] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function href(path: DavPath, node: NodeRow, child: boolean): string {
  const parts = path.segments.map((segment) => encodeURIComponent(segment.name));
  if (child) parts.push(encodeURIComponent(node.name));
  else if (parts.length > 0) parts[parts.length - 1] = encodeURIComponent(node.name);
  const value = `/dav/${parts.join("/")}`;
  return node.kind === "file" ? value : `${value.replace(/\/$/, "")}/`;
}

function liveValue(node: NodeRow, name: string, namesOnly: boolean): string | null {
  if (name === "getcontentlength" && node.kind !== "file") return null;
  if (namesOnly) return "";
  if (name === "displayname") return escapeXml(node.name);
  if (name === "getetag") return escapeXml(`"${node.id}-${node.revision}"`);
  if (name === "getcontentlength") {
    if (!Number.isSafeInteger(node.size) || (node.size ?? -1) < 0)
      throw new Error("dav_data_invalid");
    return String(node.size);
  }
  if (name === "getlastmodified") return escapeXml(new Date(node.updatedAt).toUTCString());
  if (name === "creationdate") return escapeXml(new Date(node.createdAt).toISOString());
  if (name === "resourcetype") return node.kind === "file" ? "" : "<D:collection/>";
  if (name === "lockdiscovery" || name === "supportedlock") return "";
  return null;
}

function davProperty(name: string, value: string): string {
  return value === "" ? `<D:${name}/>` : `<D:${name}>${value}</D:${name}>`;
}

function deadProperty(property: PropRow, namesOnly: boolean): string {
  if (
    !XML_NAME.test(property.name) ||
    property.namespace.length > 2048 ||
    property.valueXml.length > 8192 ||
    /<!DOCTYPE|<!ENTITY/i.test(property.valueXml)
  )
    throw new Error("dav_data_invalid");
  validateDavXmlFragment(property.valueXml);
  const open = `<N:${property.name} xmlns:N="${escapeXml(property.namespace)}"`;
  return namesOnly || property.valueXml === ""
    ? `${open}/>`
    : `${open}>${property.valueXml}</N:${property.name}>`;
}

function requestedProperties(
  request: PropfindRequest,
  node: NodeRow,
  props: readonly PropRow[],
): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  const namesOnly = request.mode === "propname";
  const wanted: readonly DavPropertyName[] =
    request.mode === "prop"
      ? request.properties
      : [
          ...LIVE.map((name) => ({ namespace: DAV, name })),
          ...props.map(({ namespace, name }) => ({ namespace, name })),
        ];
  const seen = new Set<string>();
  for (const property of wanted) {
    const key = `${property.namespace}\0${property.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (property.namespace === DAV && (LIVE as readonly string[]).includes(property.name)) {
      const value = liveValue(node, property.name, namesOnly);
      if (value === null) missing.push(davProperty(property.name, ""));
      else found.push(davProperty(property.name, value));
      continue;
    }
    const dead = props.find(
      (candidate) => candidate.namespace === property.namespace && candidate.name === property.name,
    );
    if (dead) found.push(deadProperty(dead, namesOnly));
    else {
      if (!XML_NAME.test(property.name) || property.namespace.length > 2048)
        throw new Error("dav_data_invalid");
      missing.push(`<N:${property.name} xmlns:N="${escapeXml(property.namespace)}"/>`);
    }
  }
  return { found, missing };
}

function responseXml(
  path: DavPath,
  node: NodeRow,
  child: boolean,
  request: PropfindRequest,
  props: readonly PropRow[],
): string {
  const selected = requestedProperties(request, node, props);
  const propstat = (properties: readonly string[], status: number, text: string) =>
    properties.length === 0
      ? ""
      : `<D:propstat><D:prop>${properties.join("")}</D:prop><D:status>HTTP/1.1 ${status} ${text}</D:status></D:propstat>`;
  return `<D:response><D:href>${escapeXml(href(path, node, child))}</D:href>${propstat(selected.found, 200, "OK")}${propstat(selected.missing, 404, "Not Found")}</D:response>`;
}

/** Read a parent and at most 1,000 direct children under one current authority snapshot. */
export async function propfindResponse(
  db: D1Database,
  authorized: AuthorizedNode,
  path: DavPath,
  depth: 0 | 1,
  request: PropfindRequest,
): Promise<Response> {
  if (authorized.operation !== "node.read") throw new Error("dav_node_unavailable");
  const nodeId = authorized.node.id;
  if (depth === 1) {
    const count = await primary(db)
      .prepare(
        "SELECT COUNT(*) AS count FROM nodes WHERE parent_id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL",
      )
      .bind(nodeId, authorized.node.space_id, authorized.node.owner_id)
      .first<number>("count");
    if (count === null || count > MAX_CHILDREN) throw new Error("dav_children_limit");
  }
  const targets = `WITH targets AS (
    SELECT n.* FROM nodes n WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.deleted_at IS NULL
    UNION ALL
    SELECT n.* FROM nodes n WHERE ?=1 AND n.parent_id=? AND n.space_id=? AND n.owner_id=?
      AND n.deleted_at IS NULL ORDER BY name_ci,id LIMIT ${MAX_CHILDREN + 2}
  )`;
  const values = [
    nodeId,
    authorized.node.space_id,
    authorized.node.owner_id,
    depth,
    nodeId,
    authorized.node.space_id,
    authorized.node.owner_id,
  ] as const;
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    assertExists(
      `SELECT 1 WHERE ?=0 OR (SELECT COUNT(*) FROM nodes
        WHERE parent_id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL)<=${MAX_CHILDREN}`,
      [depth, nodeId, authorized.node.space_id, authorized.node.owner_id],
    ),
    {
      sql: `${targets} SELECT t.id,t.name,t.kind,t.revision,t.current_blob_id AS currentBlobId,
        b.size,t.created_at AS createdAt,t.updated_at AS updatedAt
        FROM targets t LEFT JOIN blobs b ON b.id=t.current_blob_id AND b.owner_id=t.owner_id
        ORDER BY CASE WHEN t.id=? THEN 0 ELSE 1 END,t.name_ci,t.id`,
      values: [...values, nodeId],
    },
    {
      sql: `${targets} SELECT p.node_id AS nodeId,p.namespace,p.name,p.value_xml AS valueXml
        FROM targets t JOIN node_props p ON p.node_id=t.id ORDER BY p.node_id,p.namespace,p.name`,
      values,
    },
  ]);
  const nodes = (batches[2]?.results ?? []) as NodeRow[];
  const props = (batches[3]?.results ?? []) as PropRow[];
  if (nodes.length < 1 || nodes.length > MAX_CHILDREN + 1 || nodes[0]?.id !== nodeId)
    throw new Error("dav_data_invalid");
  for (const node of nodes) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(node.id) ||
      typeof node.name !== "string" ||
      new TextEncoder().encode(node.name).byteLength > 255 ||
      !["root", "folder", "file"].includes(node.kind) ||
      !Number.isSafeInteger(node.revision) ||
      node.revision < 1 ||
      !Number.isSafeInteger(node.createdAt) ||
      !Number.isSafeInteger(node.updatedAt) ||
      node.createdAt < 0 ||
      node.updatedAt < 0 ||
      node.createdAt > 8_640_000_000_000_000 ||
      node.updatedAt > 8_640_000_000_000_000
    )
      throw new Error("dav_data_invalid");
  }
  const counts = new Map<string, number>();
  for (const prop of props) {
    const count = (counts.get(prop.nodeId) ?? 0) + 1;
    if (count > 100) throw new Error("dav_data_invalid");
    counts.set(prop.nodeId, count);
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${nodes
    .map((node, index) =>
      responseXml(
        path,
        node,
        index !== 0,
        request,
        props.filter((property) => property.nodeId === node.id),
      ),
    )
    .join("")}</D:multistatus>`;
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
    throw new Error("dav_response_too_large");
  return new Response(body, {
    status: 207,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
