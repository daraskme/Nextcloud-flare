import { davEtag } from "./contract.js";
import {
  davXmlResponse,
  parseDavXml,
  serializeDavContent,
  xmlText,
  type DavXmlNode,
} from "./davXml.js";
import type { DavNode } from "./path.js";
import type { Env } from "../env.js";

export interface DavPropertyName {
  namespace: string;
  localName: string;
}

export interface DavPropertyChange extends DavPropertyName {
  action: "set" | "remove";
  valueXml: string;
}

export type PropfindMode = "allprop" | "propname" | "prop";

export interface PropfindRequest {
  mode: PropfindMode;
  properties: DavPropertyName[];
}

const DAV = "DAV:";
const liveProperties = [
  "displayname",
  "getetag",
  "getcontentlength",
  "getlastmodified",
  "resourcetype",
  "lockdiscovery",
  "supportedlock",
  "creationdate",
] as const;
const protectedProperties = new Set<string>(
  liveProperties.filter((name) => name !== "displayname"),
);

function qname(node: DavXmlNode): DavPropertyName {
  return { namespace: node.namespace, localName: node.localName };
}

function isDav(node: DavXmlNode, name: string): boolean {
  return node.namespace === DAV && node.localName === name;
}

export async function parsePropfind(request: Request): Promise<PropfindRequest> {
  const root = await parseDavXml(request, false);
  if (root === null) return { mode: "allprop", properties: [] };
  if (!isDav(root, "propfind")) throw new RangeError("PROPFIND XML is invalid");
  const form = root.children.filter((child) =>
    ["allprop", "propname", "prop"].some((name) => isDav(child, name)),
  );
  if (form.length !== 1) throw new RangeError("PROPFIND form is invalid");
  const selected = form[0];
  if (selected === undefined) throw new RangeError("PROPFIND form is invalid");
  if (isDav(selected, "allprop")) return { mode: "allprop", properties: [] };
  if (isDav(selected, "propname")) return { mode: "propname", properties: [] };
  if (selected.children.length > 100) throw new RangeError("Property limit exceeded");
  return { mode: "prop", properties: selected.children.map(qname) };
}

export async function parseProppatch(request: Request): Promise<DavPropertyChange[]> {
  const root = await parseDavXml(request, true);
  if (root === null || !isDav(root, "propertyupdate")) {
    throw new RangeError("PROPPATCH XML is invalid");
  }
  const changes: DavPropertyChange[] = [];
  for (const operation of root.children) {
    const action = isDav(operation, "set") ? "set" : isDav(operation, "remove") ? "remove" : null;
    if (action === null) throw new RangeError("PROPPATCH operation is invalid");
    const propertyContainers = operation.children.filter((child) => isDav(child, "prop"));
    const propertyContainer = propertyContainers[0];
    if (propertyContainers.length !== 1 || propertyContainer === undefined) {
      throw new RangeError("PROPPATCH property is invalid");
    }
    for (const property of propertyContainer.children) {
      const valueXml = action === "set" ? serializeDavContent(property) : "";
      if (new TextEncoder().encode(valueXml).byteLength > 8192) {
        throw new RangeError("Property value exceeds the limit");
      }
      changes.push({ ...qname(property), action, valueXml });
      if (changes.length > 100) throw new RangeError("Property limit exceeded");
    }
  }
  if (changes.length === 0) throw new RangeError("PROPPATCH requires properties");
  return changes;
}

export function protectedPropertyFailure(changes: readonly DavPropertyChange[]): number | null {
  const index = changes.findIndex(
    (change) =>
      change.namespace === DAV &&
      protectedProperties.has(change.localName as (typeof liveProperties)[number]),
  );
  return index < 0 ? null : index;
}

interface DeadPropertyRow {
  nodeId: string;
  namespace: string;
  name: string;
  value: string;
}

interface LockRow {
  nodeId: string;
  depth: string;
  expiresAt: number;
  creatorUserId: string;
}

function propertyTag(property: DavPropertyName, content = ""): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(property.localName)) {
    throw new RangeError("Property name is invalid");
  }
  if (property.namespace === DAV)
    return `<D:${property.localName}>${content}</D:${property.localName}>`;
  return `<N:${property.localName} xmlns:N="${xmlText(property.namespace)}">${content}</N:${property.localName}>`;
}

function liveProperty(
  node: DavNode,
  property: DavPropertyName,
  locks: readonly LockRow[],
): string | null {
  if (property.namespace !== DAV) return null;
  switch (property.localName) {
    case "displayname":
      return propertyTag(property, xmlText(node.name || "My Drive"));
    case "getetag":
      return propertyTag(
        property,
        xmlText(davEtag(node.id, node.revision, node.blobId ?? undefined)),
      );
    case "getcontentlength":
      return node.kind === "file" ? propertyTag(property, String(node.size ?? 0)) : null;
    case "getlastmodified":
      return propertyTag(property, new Date(node.updatedAt).toUTCString());
    case "resourcetype":
      return propertyTag(property, node.kind === "file" ? "" : "<D:collection/>");
    case "creationdate":
      return propertyTag(property, new Date(node.createdAt).toISOString());
    case "supportedlock":
      return propertyTag(
        property,
        "<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>",
      );
    case "lockdiscovery":
      return propertyTag(
        property,
        locks
          .filter((lock) => lock.nodeId === node.id)
          .map(
            (lock) =>
              `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${lock.depth === "infinity" ? "Infinity" : "0"}</D:depth><D:timeout>Second-${Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000))}</D:timeout></D:activelock>`,
          )
          .join(""),
      );
    default:
      return null;
  }
}

export async function renderPropfind(
  env: Env,
  nodes: readonly DavNode[],
  request: PropfindRequest,
): Promise<Response> {
  const nodeIds = nodes.filter((node) => !node.id.startsWith("shared-")).map((node) => node.id);
  const encoded = JSON.stringify(nodeIds);
  const [propertiesResult, locksResult] = await Promise.all([
    nodeIds.length === 0
      ? Promise.resolve({ results: [] as DeadPropertyRow[] })
      : env.DB.prepare(
          "SELECT node_id nodeId,namespace_uri namespace,local_name name,value_xml value FROM node_props WHERE node_id IN (SELECT value FROM json_each(?1)) ORDER BY node_id,namespace_uri,local_name",
        )
          .bind(encoded)
          .all<DeadPropertyRow>(),
    nodeIds.length === 0
      ? Promise.resolve({ results: [] as LockRow[] })
      : env.DB.prepare(
          "SELECT node_id nodeId,depth,expires_at expiresAt,creator_user_id creatorUserId FROM locks WHERE node_id IN (SELECT value FROM json_each(?1)) AND expires_at>(strftime('%s','now')*1000)",
        )
          .bind(encoded)
          .all<LockRow>(),
  ]);
  const responses = nodes.map((node) => {
    const dead = propertiesResult.results.filter((property) => property.nodeId === node.id);
    const available: DavPropertyName[] = [
      ...liveProperties.map((localName) => ({ namespace: DAV, localName })),
      ...dead.map((property) => ({ namespace: property.namespace, localName: property.name })),
    ];
    const wanted = request.mode === "prop" ? request.properties : available;
    if (request.mode === "propname") {
      return `<D:response><D:href>${xmlText(node.href)}</D:href><D:propstat><D:prop>${wanted.map((property) => propertyTag(property)).join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    }
    const found: string[] = [];
    const missing: string[] = [];
    for (const property of wanted) {
      const live = liveProperty(node, property, locksResult.results);
      const stored = dead.find(
        (item) => item.namespace === property.namespace && item.name === property.localName,
      );
      if (live !== null) found.push(live);
      else if (stored !== undefined) found.push(propertyTag(property, stored.value));
      else missing.push(propertyTag(property));
    }
    return `<D:response><D:href>${xmlText(node.href)}</D:href>${found.length === 0 ? "" : `<D:propstat><D:prop>${found.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`}${missing.length === 0 ? "" : `<D:propstat><D:prop>${missing.join("")}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`}</D:response>`;
  });
  return davXmlResponse(`<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`);
}

export function renderProppatchResult(
  href: string,
  changes: readonly DavPropertyChange[],
  failureIndex: number | null,
): Response {
  const statuses = changes.map((change, index) => {
    const status =
      failureIndex === null
        ? "HTTP/1.1 200 OK"
        : index === failureIndex
          ? "HTTP/1.1 403 Forbidden"
          : "HTTP/1.1 424 Failed Dependency";
    return `<D:propstat><D:prop>${propertyTag(change)}</D:prop><D:status>${status}</D:status></D:propstat>`;
  });
  return davXmlResponse(
    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlText(href)}</D:href>${statuses.join("")}</D:response></D:multistatus>`,
  );
}
