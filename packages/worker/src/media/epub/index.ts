import { XMLParser } from "fast-xml-parser";
import {
  inspectZipDirectory,
  isZipTransient,
  readZipEntry,
  type ZipEntry,
  ZipFormatError,
  type ZipObjectSource,
} from "./zip";

export const EPUB_INDEX_GENERATOR = "epub-index-v1";
export const EPUB_INDEX_VARIANT = "publication";
export const MAX_EPUB_INDEX_BYTES = 8_388_608;

const MAX_XML_BYTES = 2_097_152;
const MAX_TEXT_BYTES = 1_024;
const EPUB_MIMETYPE = "application/epub+zip";
const XHTML_MIME = "application/xhtml+xml";

interface IndexedEntry extends ZipEntry {
  readonly token: string;
  readonly mime: string;
}

export interface EpubIndex {
  readonly v: 1;
  readonly format: "epub";
  readonly generatorVersion: typeof EPUB_INDEX_GENERATOR;
  readonly source: {
    readonly size: number;
    readonly r2Etag: string;
  };
  readonly metadata: {
    readonly title: string | null;
    readonly author: string | null;
    readonly series: string | null;
  };
  readonly entries: readonly IndexedEntry[];
  readonly spine: readonly string[];
  readonly coverToken: string | null;
}

export type EpubInspection =
  | {
      readonly kind: "indexed";
      readonly index: EpubIndex;
      readonly bytes: Uint8Array;
      readonly sha256: string;
    }
  | { readonly kind: "unsupported" | "malformed" | "transient"; readonly code: string };

type XmlRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  removeNSPrefix: true,
  maxNestedTags: 32,
});

function record(value: unknown): XmlRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ZipFormatError("invalid_epub_xml");
  return value as XmlRecord;
}

function items(value: unknown): readonly unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function boundedText(value: unknown): string | null {
  const selected =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as XmlRecord)["#text"]
        : null;
  if (typeof selected !== "string") return null;
  const normalized = selected.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_TEXT_BYTES)
    throw new ZipFormatError("metadata_too_large");
  return normalized;
}

function parseXml(bytes: Uint8Array): XmlRecord {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_XML_BYTES)
    throw new ZipFormatError("invalid_epub_xml");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ZipFormatError("invalid_epub_xml");
  }
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(value))
    throw new ZipFormatError("unsupported_epub_xml");
  try {
    return record(xmlParser.parse(value));
  } catch {
    throw new ZipFormatError("invalid_epub_xml");
  }
}

function resolvePath(basePath: string, href: string): string {
  if (
    !href ||
    href.length > 2_048 ||
    href.includes("\\") ||
    href.includes("?") ||
    href.startsWith("/") ||
    href.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)
  )
    throw new ZipFormatError("unsupported_epub_href");
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#", 1)[0] ?? "");
  } catch {
    throw new ZipFormatError("unsupported_epub_href");
  }
  const parts = basePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new ZipFormatError("unsupported_epub_href");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  if (!path || path.normalize("NFC") !== path) throw new ZipFormatError("unsupported_epub_href");
  return path;
}

function entryToken(index: number, entry: ZipEntry): string {
  return `e${index.toString(36)}_${entry.crc32.toString(16).padStart(8, "0")}`;
}

function mimeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "xhtml" || extension === "html" || extension === "htm") return XHTML_MIME;
  if (extension === "css") return "text/css";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "avif") return "image/avif";
  if (extension === "woff") return "font/woff";
  if (extension === "woff2") return "font/woff2";
  if (extension === "ttf") return "font/ttf";
  if (extension === "otf") return "font/otf";
  if (extension === "ncx") return "application/x-dtbncx+xml";
  if (extension === "xml" || extension === "opf") return "application/xml";
  return "application/octet-stream";
}

function rootfilePath(container: XmlRecord): string {
  const rootfiles = record(record(container.container).rootfiles);
  const roots = items(rootfiles.rootfile).map(record);
  if (roots.length !== 1) throw new ZipFormatError("unsupported_epub_roots");
  const path = roots[0]!["@_full-path"];
  const mediaType = roots[0]!["@_media-type"];
  if (
    typeof path !== "string" ||
    typeof mediaType !== "string" ||
    mediaType !== "application/oebps-package+xml"
  )
    throw new ZipFormatError("invalid_epub_container");
  return resolvePath("_root", path);
}

function packageData(
  opfPath: string,
  parsed: XmlRecord,
  byPath: ReadonlyMap<string, IndexedEntry>,
): Pick<EpubIndex, "metadata" | "spine" | "coverToken"> {
  const packageNode = record(parsed.package);
  const version = packageNode["@_version"];
  if (typeof version !== "string" || !/^(?:2|3)(?:\.|$)/.test(version))
    throw new ZipFormatError("unsupported_epub_version");
  const metadataNode = record(packageNode.metadata);
  for (const meta of items(metadataNode.meta).map(record)) {
    const property = meta["@_property"];
    const name = meta["@_name"];
    const content = meta["@_content"];
    const value = boundedText(meta);
    if (
      (property === "rendition:layout" && value === "pre-paginated") ||
      (name === "rendition:layout" && content === "pre-paginated")
    )
      throw new ZipFormatError("unsupported_fixed_layout");
  }
  const manifestNode = record(packageNode.manifest);
  const manifest = new Map<
    string,
    { readonly entry: IndexedEntry; readonly mediaType: string; readonly properties: string }
  >();
  for (const item of items(manifestNode.item).map(record)) {
    const id = item["@_id"];
    const href = item["@_href"];
    const mediaType = item["@_media-type"];
    const properties = typeof item["@_properties"] === "string" ? item["@_properties"] : "";
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 256 ||
      typeof href !== "string" ||
      typeof mediaType !== "string" ||
      typeof properties !== "string" ||
      typeof item["@_media-overlay"] === "string" ||
      properties.split(/\s+/).includes("scripted") ||
      ["application/javascript", "text/javascript"].includes(mediaType)
    )
      throw new ZipFormatError("unsupported_epub_manifest");
    const entry = byPath.get(resolvePath(opfPath, href));
    if (!entry || manifest.has(id)) throw new ZipFormatError("invalid_epub_manifest");
    manifest.set(id, { entry, mediaType, properties });
  }
  const spineNode = record(packageNode.spine);
  const spine: string[] = [];
  for (const itemref of items(spineNode.itemref).map(record)) {
    const idref = itemref["@_idref"];
    if (typeof idref !== "string") throw new ZipFormatError("invalid_epub_spine");
    const item = manifest.get(idref);
    if (!item || item.mediaType !== XHTML_MIME || item.entry.mime !== XHTML_MIME)
      throw new ZipFormatError("unsupported_epub_spine");
    spine.push(item.entry.token);
  }
  if (spine.length < 1 || spine.length > 1_000) throw new ZipFormatError("invalid_epub_spine");
  const cover = [...manifest.values()].find((item) =>
    item.properties.split(/\s+/).includes("cover-image"),
  );
  const seriesMeta = items(metadataNode.meta)
    .map(record)
    .find(
      (meta) =>
        meta["@_property"] === "belongs-to-collection" || meta["@_name"] === "calibre:series",
    );
  const series =
    seriesMeta?.["@_property"] === "belongs-to-collection"
      ? boundedText(seriesMeta)
      : boundedText(seriesMeta?.["@_content"]);
  return Object.freeze({
    metadata: Object.freeze({
      title: boundedText(metadataNode.title),
      author: boundedText(metadataNode.creator),
      series: boundedText(series),
    }),
    spine: Object.freeze(spine),
    coverToken: cover?.entry.token ?? null,
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectEpubObject(
  bucket: R2Bucket,
  source: ZipObjectSource,
  deadline: number,
): Promise<EpubInspection> {
  try {
    const directory = await inspectZipDirectory(bucket, source, deadline);
    const indexed = directory.map((entry, index) =>
      Object.freeze({ ...entry, token: entryToken(index, entry), mime: mimeForPath(entry.path) }),
    );
    const byPath = new Map(indexed.map((entry) => [entry.path, entry]));
    if (byPath.has("META-INF/encryption.xml"))
      return { kind: "unsupported", code: "encrypted_epub" };
    const mimetype = byPath.get("mimetype");
    const container = byPath.get("META-INF/container.xml");
    if (
      !mimetype ||
      mimetype.localHeaderOffset !== 0 ||
      mimetype.method !== 0 ||
      mimetype.size !== EPUB_MIMETYPE.length ||
      !container
    )
      return { kind: "malformed", code: "invalid_epub_container" };
    const mimetypeBytes = await readZipEntry(bucket, source, mimetype, deadline);
    if (new TextDecoder().decode(mimetypeBytes) !== EPUB_MIMETYPE)
      return { kind: "malformed", code: "invalid_epub_mimetype" };
    const containerXml = parseXml(await readZipEntry(bucket, source, container, deadline));
    const opfPath = rootfilePath(containerXml);
    const opf = byPath.get(opfPath);
    if (!opf) return { kind: "malformed", code: "missing_epub_package" };
    const packageXml = parseXml(await readZipEntry(bucket, source, opf, deadline));
    const publication = packageData(opfPath, packageXml, byPath);
    for (const token of publication.spine) {
      const entry = indexed.find((candidate) => candidate.token === token);
      if (!entry) throw new ZipFormatError("invalid_epub_spine");
      const markup = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readZipEntry(bucket, source, entry, deadline),
      );
      if (
        /<\s*(?:script|iframe|object|embed)\b/i.test(markup) ||
        /\bon[a-z]+\s*=/i.test(markup) ||
        /\bjavascript\s*:/i.test(markup)
      )
        throw new ZipFormatError("unsupported_scripted_epub");
    }
    const index: EpubIndex = Object.freeze({
      v: 1,
      format: "epub",
      generatorVersion: EPUB_INDEX_GENERATOR,
      source: Object.freeze({ size: source.size, r2Etag: source.r2Etag }),
      metadata: publication.metadata,
      entries: Object.freeze(indexed),
      spine: publication.spine,
      coverToken: publication.coverToken,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(index));
    if (bytes.byteLength > MAX_EPUB_INDEX_BYTES)
      return { kind: "unsupported", code: "index_too_large" };
    return Object.freeze({ kind: "indexed", index, bytes, sha256: await sha256(bytes) });
  } catch (error) {
    if (isZipTransient(error)) return { kind: "transient", code: "source_unavailable" };
    if (error instanceof ZipFormatError) {
      const unsupported =
        error.code.startsWith("unsupported_") ||
        error.code === "archive_too_large" ||
        error.code === "entry_output_limit" ||
        error.code === "metadata_too_large";
      return { kind: unsupported ? "unsupported" : "malformed", code: error.code };
    }
    return { kind: "transient", code: "inspection_failed" };
  }
}

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new Error("invalid_epub_index");
  return value as number;
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maximum)
    throw new Error("invalid_epub_index");
  return value;
}

export function parseEpubIndex(bytes: Uint8Array, source: ZipObjectSource): EpubIndex {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EPUB_INDEX_BYTES)
    throw new Error("invalid_epub_index");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("invalid_epub_index");
  }
  const root = record(value);
  if (root.v !== 1 || root.format !== "epub" || root.generatorVersion !== EPUB_INDEX_GENERATOR)
    throw new Error("invalid_epub_index");
  const sourceValue = record(root.source);
  if (
    number(sourceValue.size, 0xffffffff) !== source.size ||
    string(sourceValue.r2Etag, 256) !== source.r2Etag
  )
    throw new Error("invalid_epub_index");
  const metadataValue = record(root.metadata);
  const metadata = {
    title: metadataValue.title === null ? null : string(metadataValue.title, MAX_TEXT_BYTES),
    author: metadataValue.author === null ? null : string(metadataValue.author, MAX_TEXT_BYTES),
    series: metadataValue.series === null ? null : string(metadataValue.series, MAX_TEXT_BYTES),
  };
  if (!Array.isArray(root.entries) || root.entries.length < 1 || root.entries.length > 1_000)
    throw new Error("invalid_epub_index");
  const tokens = new Set<string>();
  const paths = new Set<string>();
  const entries = root.entries.map((raw, index) => {
    const entry = record(raw);
    const token = string(entry.token, 128);
    const path = string(entry.path, 1_024);
    const method = number(entry.method, 8);
    const flags = number(entry.flags, 0xffff);
    const selected: IndexedEntry = {
      token,
      path,
      method: method as 0 | 8,
      flags,
      crc32: number(entry.crc32, 0xffffffff),
      compressedSize: number(entry.compressedSize, 16_777_216),
      size: number(entry.size, 16_777_216),
      localHeaderOffset: number(entry.localHeaderOffset, 0xffffffff),
      mime: string(entry.mime, 128),
    };
    if (
      (method !== 0 && method !== 8) ||
      tokens.has(token) ||
      paths.has(path) ||
      entryToken(index, selected) !== token
    )
      throw new Error("invalid_epub_index");
    tokens.add(token);
    paths.add(path);
    return Object.freeze(selected);
  });
  if (!Array.isArray(root.spine) || root.spine.length < 1 || root.spine.length > 1_000)
    throw new Error("invalid_epub_index");
  const spine = root.spine.map((token) => {
    const selected = string(token, 128);
    if (!tokens.has(selected)) throw new Error("invalid_epub_index");
    return selected;
  });
  const coverToken = root.coverToken === null ? null : string(root.coverToken, 128);
  if (coverToken !== null && !tokens.has(coverToken)) throw new Error("invalid_epub_index");
  return Object.freeze({
    v: 1,
    format: "epub",
    generatorVersion: EPUB_INDEX_GENERATOR,
    source: Object.freeze({ size: source.size, r2Etag: source.r2Etag }),
    metadata: Object.freeze(metadata),
    entries: Object.freeze(entries),
    spine: Object.freeze(spine),
    coverToken,
  });
}

export async function verifyEpubIndexHash(bytes: Uint8Array, expected: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expected) || (await sha256(bytes)) !== expected)
    throw new Error("invalid_epub_index");
}
