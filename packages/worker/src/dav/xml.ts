import { XMLParser } from "fast-xml-parser";

const DAV = "DAV:";
const XINCLUDE = "http://www.w3.org/2001/XInclude";
const MAX_XML_BYTES = 1_048_576;
const MAX_ELEMENTS = 10_000;
const MAX_ATTRIBUTES = 20_000;
const MAX_NAMESPACES = 100;
const MAX_PROPERTIES = 100;

export interface DavPropertyName {
  readonly namespace: string;
  readonly name: string;
}
export type PropfindRequest =
  | { readonly mode: "allprop" | "propname"; readonly properties: readonly [] }
  | { readonly mode: "prop"; readonly properties: readonly DavPropertyName[] };
export interface ProppatchChange extends DavPropertyName {
  readonly action: "set" | "remove";
  readonly valueXml: string;
}
export type LockinfoRequest =
  | { readonly kind: "refresh" }
  | { readonly kind: "create"; readonly ownerXml: string };

type OrderedNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  maxNestedTags: 32,
});

async function boundedBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,7}$/.test(declared) || Number(declared) > MAX_XML_BYTES))
    throw new Error("invalid_dav_xml");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_XML_BYTES) throw new Error("invalid_dav_xml");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("invalid_dav_xml");
  }
}

function content(nodes: unknown): OrderedNode[] {
  if (!Array.isArray(nodes)) throw new Error("invalid_dav_xml");
  return nodes.filter((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error("invalid_dav_xml");
    const text = (node as OrderedNode)["#text"];
    if (text === undefined) return true;
    if (typeof text !== "string" || text.trim() !== "") throw new Error("invalid_dav_xml");
    return false;
  }) as OrderedNode[];
}

function element(node: OrderedNode): { tag: string; children: OrderedNode[]; attrs: OrderedNode } {
  const tags = Object.keys(node).filter((key) => key !== ":@" && key !== "#text");
  if (tags.length !== 1) throw new Error("invalid_dav_xml");
  const tag = tags[0]!;
  const attrs = node[":@"];
  if (attrs !== undefined && (!attrs || typeof attrs !== "object" || Array.isArray(attrs)))
    throw new Error("invalid_dav_xml");
  return { tag, children: content(node[tag]), attrs: (attrs as OrderedNode | undefined) ?? {} };
}

function mixedElement(node: OrderedNode): {
  tag: string;
  children: OrderedNode[];
  attrs: OrderedNode;
} {
  const tags = Object.keys(node).filter((key) => key !== ":@" && key !== "#text");
  if (tags.length !== 1 || Object.hasOwn(node, "#text")) throw new Error("invalid_dav_xml");
  const tag = tags[0]!;
  const children = node[tag];
  const attrs = node[":@"];
  if (
    !Array.isArray(children) ||
    (attrs !== undefined && (!attrs || typeof attrs !== "object" || Array.isArray(attrs)))
  )
    throw new Error("invalid_dav_xml");
  for (const child of children) {
    if (!child || typeof child !== "object" || Array.isArray(child))
      throw new Error("invalid_dav_xml");
  }
  return {
    tag,
    children: children as OrderedNode[],
    attrs: (attrs as OrderedNode | undefined) ?? {},
  };
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&apos;") return "'";
    if (entity === "&quot;") return '"';
    const hex = entity.startsWith("&#x");
    const codepoint = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (
      !Number.isInteger(codepoint) ||
      codepoint < 1 ||
      codepoint > 0x10ffff ||
      (codepoint >= 0xd800 && codepoint <= 0xdfff)
    )
      throw new Error("invalid_dav_xml");
    return String.fromCodePoint(codepoint);
  });
}

function namespaces(attrs: OrderedNode, parent: ReadonlyMap<string, string>) {
  const result = new Map(parent);
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith("@_xmlns") || typeof value !== "string" || value.length > 2048)
      throw new Error("invalid_dav_xml");
    const prefix = key === "@_xmlns" ? "" : key.slice(8);
    if (!prefix && key !== "@_xmlns") throw new Error("invalid_dav_xml");
    const decoded = decodeEntities(value);
    if (decoded === XINCLUDE) throw new Error("invalid_dav_xml");
    result.set(prefix, decoded);
    if (result.size > MAX_NAMESPACES) throw new Error("invalid_dav_xml");
  }
  return result;
}

function mixedNamespaces(attrs: OrderedNode, parent: ReadonlyMap<string, string>) {
  const declarations = Object.fromEntries(
    Object.entries(attrs).filter(([key]) => key.startsWith("@_xmlns")),
  );
  return namespaces(declarations, parent);
}

function qualified(tag: string, scope: ReadonlyMap<string, string>): DavPropertyName {
  const parts = tag.split(":");
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error("invalid_dav_xml");
  const prefix = parts.length === 2 ? parts[0]! : "";
  const namespace = scope.get(prefix);
  if (namespace === undefined) throw new Error("invalid_dav_xml");
  return { namespace, name: parts.at(-1)! };
}

const XML_LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/;
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Normalize mixed content so every generated qualified name carries its own namespace binding. */
function serializeContent(
  nodes: readonly OrderedNode[],
  scope: ReadonlyMap<string, string>,
): string {
  let serial = 0;
  const write = (items: readonly OrderedNode[], inherited: ReadonlyMap<string, string>): string =>
    items
      .map((node) => {
        if (Object.hasOwn(node, "#text")) {
          if (Object.keys(node).some((key) => key !== "#text")) throw new Error("invalid_dav_xml");
          const value = node["#text"];
          if (typeof value !== "string") throw new Error("invalid_dav_xml");
          return escapeXml(decodeEntities(value));
        }
        const item = mixedElement(node);
        const current = mixedNamespaces(item.attrs, inherited);
        const name = qualified(item.tag, current);
        if (!XML_LOCAL_NAME.test(name.name) || name.namespace.length > 2048)
          throw new Error("invalid_dav_xml");
        const prefix = `N${serial++}`;
        const attributes: string[] = [`xmlns:${prefix}="${escapeXml(name.namespace)}"`];
        for (const [raw, rawValue] of Object.entries(item.attrs)) {
          if (raw.startsWith("@_xmlns")) continue;
          if (!raw.startsWith("@_") || typeof rawValue !== "string")
            throw new Error("invalid_dav_xml");
          const attributeName = raw.slice(2);
          const parts = attributeName.split(":");
          if (parts.length > 2 || parts.some((part) => !XML_LOCAL_NAME.test(part)))
            throw new Error("invalid_dav_xml");
          if (parts.length === 1) {
            attributes.push(`${parts[0]}="${escapeXml(decodeEntities(rawValue))}"`);
          } else {
            const namespace = current.get(parts[0]!);
            if (namespace === undefined || namespace.length > 2048)
              throw new Error("invalid_dav_xml");
            const attributePrefix = `A${serial++}`;
            attributes.push(`xmlns:${attributePrefix}="${escapeXml(namespace)}"`);
            attributes.push(
              `${attributePrefix}:${parts[1]}="${escapeXml(decodeEntities(rawValue))}"`,
            );
          }
        }
        const children = write(item.children, current);
        const open = `<${prefix}:${name.name} ${attributes.join(" ")}`;
        return children === "" ? `${open}/>` : `${open}>${children}</${prefix}:${name.name}>`;
      })
      .join("");
  const value = write(nodes, scope);
  if (new TextEncoder().encode(value).byteLength > 8192) throw new Error("invalid_dav_xml");
  validateDavXmlFragment(value);
  return value;
}

function countStructure(value: unknown): void {
  let elements = 0;
  let attributes = 0;
  const visit = (nodes: unknown, depth: number) => {
    if (!Array.isArray(nodes) || depth > 32) throw new Error("invalid_dav_xml");
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_dav_xml");
      const node = raw as OrderedNode;
      const tags = Object.keys(node).filter((key) => key !== ":@" && key !== "#text");
      elements += tags.length;
      const attrs = node[":@"];
      if (attrs && typeof attrs === "object" && !Array.isArray(attrs))
        attributes += Object.keys(attrs).length;
      if (elements > MAX_ELEMENTS || attributes > MAX_ATTRIBUTES)
        throw new Error("invalid_dav_xml");
      for (const tag of tags) visit(node[tag], depth + 1);
    }
  };
  visit(value, 1);
}

export async function parsePropfindRequest(request: Request): Promise<PropfindRequest> {
  const xml = await boundedBody(request);
  if (xml === null) return { mode: "allprop", properties: [] };
  const type = request.headers.get("Content-Type")?.replace(/\s+/g, "") ?? "";
  if (!/^(?:application|text)\/xml(?:;charset=utf-8)?$/i.test(type))
    throw new Error("invalid_dav_xml");
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    xml.replace(/&(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, "").includes("&")
  )
    throw new Error("invalid_dav_xml");
  let ordered: unknown;
  try {
    ordered = parser.parse(xml);
  } catch {
    throw new Error("invalid_dav_xml");
  }
  countStructure(ordered);
  const top = content(ordered).filter((node) => !Object.keys(node).some((key) => key === "?xml"));
  if (top.length !== 1) throw new Error("invalid_dav_xml");
  const root = element(top[0]!);
  const rootScope = namespaces(root.attrs, new Map());
  const rootName = qualified(root.tag, rootScope);
  if (rootName.namespace !== DAV || rootName.name !== "propfind" || root.children.length !== 1)
    throw new Error("invalid_dav_xml");
  const selection = element(root.children[0]!);
  const selectionScope = namespaces(selection.attrs, rootScope);
  const selectionName = qualified(selection.tag, selectionScope);
  if (selectionName.namespace !== DAV) throw new Error("invalid_dav_xml");
  if (selectionName.name === "allprop" || selectionName.name === "propname") {
    if (selection.children.length !== 0) throw new Error("invalid_dav_xml");
    return { mode: selectionName.name, properties: [] };
  }
  if (selectionName.name !== "prop" || selection.children.length > MAX_PROPERTIES)
    throw new Error("invalid_dav_xml");
  const properties = selection.children.map((node) => {
    const property = element(node);
    if (property.children.length !== 0) throw new Error("invalid_dav_xml");
    return qualified(property.tag, namespaces(property.attrs, selectionScope));
  });
  if (properties.length === 0) throw new Error("invalid_dav_xml");
  return { mode: "prop", properties };
}

export async function parseProppatchRequest(request: Request): Promise<readonly ProppatchChange[]> {
  const xml = await boundedBody(request);
  if (xml === null) throw new Error("invalid_dav_xml");
  const type = request.headers.get("Content-Type")?.replace(/\s+/g, "") ?? "";
  if (!/^(?:application|text)\/xml(?:;charset=utf-8)?$/i.test(type))
    throw new Error("invalid_dav_xml");
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    xml.replace(/&(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, "").includes("&")
  )
    throw new Error("invalid_dav_xml");
  let ordered: unknown;
  try {
    ordered = parser.parse(xml);
  } catch {
    throw new Error("invalid_dav_xml");
  }
  countStructure(ordered);
  const top = content(ordered).filter((node) => !Object.keys(node).some((key) => key === "?xml"));
  if (top.length !== 1) throw new Error("invalid_dav_xml");
  const root = element(top[0]!);
  const rootScope = namespaces(root.attrs, new Map());
  const rootName = qualified(root.tag, rootScope);
  if (rootName.namespace !== DAV || rootName.name !== "propertyupdate")
    throw new Error("invalid_dav_xml");
  const changes: ProppatchChange[] = [];
  const seen = new Set<string>();
  for (const instructionNode of root.children) {
    const instruction = element(instructionNode);
    const instructionScope = namespaces(instruction.attrs, rootScope);
    const instructionName = qualified(instruction.tag, instructionScope);
    if (
      instructionName.namespace !== DAV ||
      !["set", "remove"].includes(instructionName.name) ||
      instruction.children.length !== 1
    )
      throw new Error("invalid_dav_xml");
    const prop = element(instruction.children[0]!);
    const propScope = namespaces(prop.attrs, instructionScope);
    const propName = qualified(prop.tag, propScope);
    if (propName.namespace !== DAV || propName.name !== "prop" || prop.children.length === 0)
      throw new Error("invalid_dav_xml");
    for (const propertyNode of prop.children) {
      if (changes.length >= MAX_PROPERTIES) throw new Error("invalid_dav_xml");
      const property = mixedElement(propertyNode);
      const propertyScope = namespaces(property.attrs, propScope);
      const name = qualified(property.tag, propertyScope);
      if (!XML_LOCAL_NAME.test(name.name) || name.namespace.length > 2048)
        throw new Error("invalid_dav_xml");
      const key = `${name.namespace}\0${name.name}`;
      if (seen.has(key)) throw new Error("invalid_dav_xml");
      seen.add(key);
      const action = instructionName.name as "set" | "remove";
      if (action === "remove" && property.children.length !== 0) throw new Error("invalid_dav_xml");
      changes.push({
        ...name,
        action,
        valueXml: action === "set" ? serializeContent(property.children, propertyScope) : "",
      });
    }
  }
  if (changes.length === 0) throw new Error("invalid_dav_xml");
  return changes;
}

export async function parseLockinfoRequest(request: Request): Promise<LockinfoRequest> {
  const xml = await boundedBody(request);
  if (xml === null) return { kind: "refresh" };
  const type = request.headers.get("Content-Type")?.replace(/\s+/g, "") ?? "";
  if (!/^(?:application|text)\/xml(?:;charset=utf-8)?$/i.test(type))
    throw new Error("invalid_dav_xml");
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    xml.replace(/&(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, "").includes("&")
  )
    throw new Error("invalid_dav_xml");
  let ordered: unknown;
  try {
    ordered = parser.parse(xml);
  } catch {
    throw new Error("invalid_dav_xml");
  }
  countStructure(ordered);
  const top = content(ordered).filter((node) => !Object.keys(node).some((key) => key === "?xml"));
  if (top.length !== 1) throw new Error("invalid_dav_xml");
  const root = element(top[0]!);
  const rootScope = namespaces(root.attrs, new Map());
  const rootName = qualified(root.tag, rootScope);
  if (rootName.namespace !== DAV || rootName.name !== "lockinfo")
    throw new Error("invalid_dav_xml");
  let exclusive = false;
  let write = false;
  let ownerXml = "";
  let ownerSeen = false;
  for (const childNode of root.children) {
    const child = mixedElement(childNode);
    const childScope = namespaces(child.attrs, rootScope);
    const childName = qualified(child.tag, childScope);
    if (childName.namespace !== DAV) throw new Error("invalid_dav_xml");
    if (childName.name === "owner") {
      if (ownerSeen) throw new Error("invalid_dav_xml");
      ownerSeen = true;
      ownerXml = serializeContent(child.children, childScope);
      continue;
    }
    const structural = content(child.children);
    if (structural.length !== 1) throw new Error("invalid_dav_xml");
    const value = element(structural[0]!);
    const valueScope = namespaces(value.attrs, childScope);
    const valueName = qualified(value.tag, valueScope);
    if (value.children.length !== 0 || valueName.namespace !== DAV)
      throw new Error("invalid_dav_xml");
    if (childName.name === "lockscope" && valueName.name === "exclusive" && !exclusive) {
      exclusive = true;
    } else if (childName.name === "locktype" && valueName.name === "write" && !write) {
      write = true;
    } else {
      throw new Error("invalid_dav_xml");
    }
  }
  if (!exclusive || !write) throw new Error("invalid_dav_xml");
  return { kind: "create", ownerXml };
}

/** Validate a stored, normalized mixed-content fragment before embedding it in DAV output. */
export function validateDavXmlFragment(value: string): void {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > 8192 ||
    /<\?xml|<!DOCTYPE|<!ENTITY|http:\/\/www\.w3\.org\/2001\/XInclude/i.test(value) ||
    value.replace(/&(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, "").includes("&")
  )
    throw new Error("invalid_dav_xml");
  try {
    if (decodeEntities(value).includes(XINCLUDE)) throw new Error("invalid_dav_xml");
    const ordered: unknown = parser.parse(`<R>${value}</R>`);
    countStructure(ordered);
    if (!Array.isArray(ordered) || ordered.length !== 1) throw new Error("invalid_dav_xml");
    const root = ordered[0];
    if (
      !root ||
      typeof root !== "object" ||
      Array.isArray(root) ||
      Object.keys(root)
        .filter((key) => key !== ":@" && key !== "#text")
        .join("") !== "R"
    )
      throw new Error("invalid_dav_xml");
  } catch {
    throw new Error("invalid_dav_xml");
  }
}
