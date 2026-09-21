import { XMLParser } from "fast-xml-parser";

export interface DavXmlNode {
  namespace: string;
  localName: string;
  attributes: Record<string, string>;
  children: DavXmlNode[];
  text: string;
  content: (string | DavXmlNode)[];
}

interface OrderedValue {
  [name: string]: unknown;
  ":@"?: Record<string, string>;
  "#text"?: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
});

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeReferences(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#(?:x[0-9A-Fa-f]+|[0-9]+));/gu,
    (_reference, name: string) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      if (named[name] !== undefined) return named[name];
      const numeric = name.slice(1);
      const point = numeric.startsWith("x")
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      return String.fromCodePoint(point);
    },
  );
}

function validateReferences(xml: string): void {
  for (const match of xml.matchAll(/&([^;]{1,32});/gu)) {
    const reference = match[1];
    if (reference === undefined) throw new RangeError("XML entity is invalid");
    if (["amp", "lt", "gt", "quot", "apos"].includes(reference)) continue;
    const numeric = /^#(x[0-9A-Fa-f]+|[0-9]+)$/u.exec(reference);
    if (numeric?.[1] === undefined) throw new RangeError("XML entity is forbidden");
    const value = numeric[1].startsWith("x")
      ? Number.parseInt(numeric[1].slice(1), 16)
      : Number.parseInt(numeric[1], 10);
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > 0x10ffff ||
      (value >= 0xd800 && value <= 0xdfff)
    ) {
      throw new RangeError("XML character reference is invalid");
    }
  }
  const withoutReferences = xml.replace(
    /&(?:amp|lt|gt|quot|apos|#(?:x[0-9A-Fa-f]+|[0-9]+));/gu,
    "",
  );
  if (withoutReferences.includes("&")) throw new RangeError("XML entity is forbidden");
}

function splitName(
  name: string,
  namespaces: ReadonlyMap<string, string>,
): { namespace: string; localName: string } {
  const separator = name.indexOf(":");
  const prefix = separator < 0 ? "" : name.slice(0, separator);
  const localName = separator < 0 ? name : name.slice(separator + 1);
  const namespace = namespaces.get(prefix) ?? "";
  if (localName.length === 0 || localName.length > 255 || namespace.length > 1024) {
    throw new RangeError("XML name is invalid");
  }
  return { namespace, localName };
}

function convert(
  value: OrderedValue,
  inheritedNamespaces: ReadonlyMap<string, string>,
  counters: { elements: number; attributes: number; namespaces: Set<string> },
  depth: number,
): DavXmlNode | null {
  if (depth > 32) throw new RangeError("XML depth exceeds the limit");
  const name = Object.keys(value).find((key) => key !== ":@" && key !== "#text");
  if (name === undefined) return null;
  counters.elements += 1;
  if (counters.elements > 10_000) throw new RangeError("XML element limit exceeded");
  const namespaces = new Map(inheritedNamespaces);
  const rawAttributes = value[":@"] ?? {};
  const attributes: Record<string, string> = {};
  for (const [attribute, attributeValue] of Object.entries(rawAttributes)) {
    counters.attributes += 1;
    if (counters.attributes > 20_000) throw new RangeError("XML attribute limit exceeded");
    const normalized = attribute.startsWith("@_") ? attribute.slice(2) : attribute;
    if (normalized === "xmlns") {
      namespaces.set("", attributeValue);
      counters.namespaces.add(attributeValue);
    } else if (normalized.startsWith("xmlns:")) {
      namespaces.set(normalized.slice(6), attributeValue);
      counters.namespaces.add(attributeValue);
    } else {
      attributes[normalized] = decodeReferences(attributeValue);
    }
  }
  if (counters.namespaces.size > 100) throw new RangeError("XML namespace limit exceeded");
  const qualified = splitName(name, namespaces);
  const content = value[name];
  const children: DavXmlNode[] = [];
  const orderedContent: (string | DavXmlNode)[] = [];
  let text = "";
  if (Array.isArray(content)) {
    for (const item of content as OrderedValue[]) {
      if (typeof item["#text"] === "string") {
        const decoded = decodeReferences(item["#text"]);
        text += decoded;
        orderedContent.push(decoded);
      }
      const child = convert(item, namespaces, counters, depth + 1);
      if (child !== null) {
        children.push(child);
        orderedContent.push(child);
      }
    }
  }
  return { ...qualified, attributes, children, text, content: orderedContent };
}

export async function parseDavXml(request: Request, required: boolean): Promise<DavXmlNode | null> {
  const contentLength = request.headers.get("Content-Length");
  if (required && contentLength === null) throw new Error("length_required");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > 1_048_576) {
      throw new RangeError("XML body exceeds the limit");
    }
    if (size === 0) return null;
  }
  const xml = await request.text();
  if (xml.length === 0) return null;
  if (new TextEncoder().encode(xml).byteLength > 1_048_576) {
    throw new RangeError("XML body exceeds the limit");
  }
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:[A-Za-z_][\w.-]*:)?include\b/iu.test(xml)) {
    throw new RangeError("XML declarations are forbidden");
  }
  validateReferences(xml);
  let ordered: unknown;
  try {
    ordered = parser.parse(xml);
  } catch {
    throw new RangeError("XML is invalid");
  }
  if (!Array.isArray(ordered) || ordered.length !== 1) throw new RangeError("XML root is invalid");
  const root = convert(
    ordered[0] as OrderedValue,
    new Map(),
    { elements: 0, attributes: 0, namespaces: new Set() },
    1,
  );
  if (root === null) throw new RangeError("XML root is invalid");
  return root;
}

export function xmlText(value: string): string {
  return escapeText(value);
}

export function serializeDavFragment(node: DavXmlNode): string {
  const name = node.namespace === "" ? node.localName : `N:${node.localName}`;
  const namespace = node.namespace === "" ? "" : ` xmlns:N="${escapeText(node.namespace)}"`;
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeText(value)}"`)
    .join("");
  const content = serializeDavContent(node);
  return `<${name}${namespace}${attributes}>${content}</${name}>`;
}

export function serializeDavContent(node: DavXmlNode): string {
  return node.content
    .map((item) => (typeof item === "string" ? escapeText(item) : serializeDavFragment(item)))
    .join("");
}

export function davXmlResponse(xml: string, status = 207): Response {
  if (new TextEncoder().encode(xml).byteLength > 32 * 1024 * 1024) {
    return new Response(null, { status: 507 });
  }
  return new Response(xml, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
