import { XMLParser, XMLValidator } from "fast-xml-parser";

const NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";
export const MAX_S3_XML_BYTES = 1_048_576;
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  maxNestedTags: 16,
});
type Ordered = Record<string, unknown>;
export interface S3Element {
  name: string;
  text: string;
  children: S3Element[];
}

export function invalidS3Xml(): never {
  throw new Error("invalid_s3_inventory_xml");
}

function xmlCharacters(value: string): boolean {
  return !/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value);
}

function decode(value: string): string {
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d{1,7}|#x[\da-fA-F]{1,6});)/.test(value)) invalidS3Xml();
  const decoded = value.replace(/&([^;]+);/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    const hex = entity.startsWith("#x");
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (code > 0x10ffff) invalidS3Xml();
    return String.fromCodePoint(code);
  });
  if (!xmlCharacters(decoded)) invalidS3Xml();
  return decoded;
}

/** Small, namespace-aware S3 response tree. Never expands user-defined entities. */
export function s3Xml(xml: string, rootName: string): S3Element {
  if (new TextEncoder().encode(xml).length > MAX_S3_XML_BYTES || !xmlCharacters(xml))
    invalidS3Xml();
  xml = xml
    .replace(/^\uFEFF/, "")
    .replace(
      /^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/i,
      "",
    );
  // Reject excessive markup before either library builds a tree or a validation stack.
  let markup = 0;
  for (let at = xml.indexOf("<"); at !== -1; at = xml.indexOf("<", at + 1)) {
    if (++markup > 20_000) invalidS3Xml();
  }
  if (/<[!?]/.test(xml) || XMLValidator.validate(xml) !== true) invalidS3Xml();
  let count = 0;
  const walk = (raw: unknown, scope: ReadonlyMap<string, string>, depth: number): S3Element => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || ++count > 10_000 || depth > 16)
      invalidS3Xml();
    const node = raw as Ordered;
    const tags = Object.keys(node).filter((key) => key !== ":@");
    if (tags.length !== 1) invalidS3Xml();
    const tag = tags[0]!;
    const names = tag.split(":");
    if (names.length > 2 || names.some((name) => !/^[A-Za-z_][A-Za-z\d._-]{0,127}$/.test(name)))
      invalidS3Xml();
    const current = new Map(scope);
    if (node[":@"] !== undefined) {
      if (!node[":@"] || typeof node[":@"] !== "object" || Array.isArray(node[":@"]))
        invalidS3Xml();
      for (const [key, value] of Object.entries(node[":@"] as Ordered)) {
        if (!/^@_xmlns(?::[A-Za-z_][A-Za-z\d._-]{0,127})?$/.test(key) || typeof value !== "string")
          invalidS3Xml();
        const prefix = key === "@_xmlns" ? "" : key.slice(8);
        if (["xml", "xmlns"].includes(prefix) || decode(value) !== NAMESPACE) invalidS3Xml();
        current.set(prefix, NAMESPACE);
        if (current.size > 32) invalidS3Xml();
      }
    }
    if (current.get(names.length === 2 ? names[0]! : "") !== NAMESPACE) invalidS3Xml();
    const content = node[tag];
    if (!Array.isArray(content)) invalidS3Xml();
    const result: S3Element = { name: names.at(-1)!, text: "", children: [] };
    for (const child of content) {
      if (child && typeof child === "object" && Object.hasOwn(child, "#text")) {
        if (Object.keys(child).length !== 1 || typeof child["#text"] !== "string") invalidS3Xml();
        result.text += decode(child["#text"]);
      } else result.children.push(walk(child, current, depth + 1));
    }
    if (result.children.length && result.text.trim()) invalidS3Xml();
    return result;
  };
  try {
    const roots: unknown = parser.parse(xml);
    if (!Array.isArray(roots) || roots.length !== 1) invalidS3Xml();
    const root = walk(roots[0], new Map(), 1);
    if (root.name !== rootName) invalidS3Xml();
    return root;
  } catch {
    return invalidS3Xml();
  }
}

/** Reject misspelled/unexpected fields and duplicates before interpreting any scalar. */
export function fields(
  node: S3Element,
  singles: readonly string[],
  repeated: readonly string[] = [],
) {
  if (node.text.trim()) invalidS3Xml();
  const seen = new Set<string>();
  for (const child of node.children) {
    if (repeated.includes(child.name)) continue;
    if (!singles.includes(child.name) || seen.has(child.name)) invalidS3Xml();
    seen.add(child.name);
  }
}

export function optional(node: S3Element, name: string): S3Element | undefined {
  const found = node.children.filter((child) => child.name === name);
  if (found.length > 1) invalidS3Xml();
  return found[0];
}

export function scalar(node: S3Element, name: string, fallback?: string): string {
  const found = optional(node, name);
  if (!found) return fallback === undefined ? invalidS3Xml() : fallback;
  if (found.children.length) invalidS3Xml();
  return found.text;
}

export function integer(value: string, min: number, max: number): number {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)) invalidS3Xml();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) invalidS3Xml();
  return result;
}

export function boolean(value: string): boolean {
  if (value !== "true" && value !== "false") invalidS3Xml();
  return value === "true";
}

export function timestamp(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) invalidS3Xml();
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0) invalidS3Xml();
  if (new Date(time).toISOString() !== value.replace(/(?<=\d\d:\d\d:\d\d)Z$/, ".000Z"))
    invalidS3Xml();
  return time;
}

export function utf8(value: string, min: number, max: number): string {
  const size = new TextEncoder().encode(value).length;
  if (size < min || size > max || !xmlCharacters(value)) invalidS3Xml();
  return value;
}

export function urlDecoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalidS3Xml();
  }
}
