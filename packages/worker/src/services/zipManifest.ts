import { storeZipSize } from "../platform/storeZip";
import type { EncodedTargetManifest, TargetEntry } from "./targetManifest";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BYTES = 1_048_576;

export interface ZipManifestEntry {
  readonly nodeId: string;
  readonly revision: number;
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly blobId: string | null;
  readonly size: number;
}

export interface ZipSnapshot {
  readonly spaceId: string;
  readonly rootNodeId: string;
  readonly rootRevision: number;
  readonly treeGeneration: number;
  readonly entries: readonly ZipManifestEntry[];
}

/** Version 2 binds an ordered STORE archive and its exact wire size to the authorized tree. */
export interface ZipTargetManifest {
  readonly v: 2;
  readonly serializer: "store-v1";
  readonly zip: ZipSnapshot;
  readonly targets: readonly TargetEntry[];
  readonly outputBytes: number;
}

function record(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function inspectSnapshot(value: unknown): ZipSnapshot {
  if (
    !record(value, "entries,rootNodeId,rootRevision,spaceId,treeGeneration") ||
    typeof value.spaceId !== "string" ||
    !ID.test(value.spaceId) ||
    typeof value.rootNodeId !== "string" ||
    !ID.test(value.rootNodeId) ||
    !positive(value.rootRevision) ||
    !positive(value.treeGeneration) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 1_000
  )
    throw new Error("invalid_zip_manifest");
  const nodes = new Set([value.rootNodeId]);
  const paths = new Map<string, "file" | "folder">();
  const entries: ZipManifestEntry[] = [];
  for (const entry of value.entries) {
    if (
      !record(entry, "blobId,kind,nodeId,path,revision,size") ||
      typeof entry.nodeId !== "string" ||
      !ID.test(entry.nodeId) ||
      nodes.has(entry.nodeId) ||
      !positive(entry.revision) ||
      typeof entry.path !== "string" ||
      entry.path !== entry.path.normalize("NFC") ||
      !["file", "folder"].includes(entry.kind as string) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.kind === "folder"
        ? entry.blobId !== null || entry.size !== 0 || !entry.path.endsWith("/")
        : typeof entry.blobId !== "string" || !ID.test(entry.blobId) || entry.path.endsWith("/"))
    )
      throw new Error("invalid_zip_manifest");
    const path = entry.kind === "folder" ? entry.path.slice(0, -1) : entry.path;
    if (paths.has(path)) throw new Error("invalid_zip_manifest");
    paths.set(path, entry.kind as "file" | "folder");
    nodes.add(entry.nodeId);
    entries.push(
      Object.freeze({
        nodeId: entry.nodeId,
        revision: entry.revision,
        path: entry.path,
        kind: entry.kind as "file" | "folder",
        blobId: entry.blobId as string | null,
        size: entry.size as number,
      }),
    );
  }
  // Every directory is represented by an authorized node, including empty directories.
  for (const path of paths.keys()) {
    const parent = path.lastIndexOf("/");
    if (parent >= 0 && paths.get(path.slice(0, parent)) !== "folder")
      throw new Error("invalid_zip_manifest");
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze({
    spaceId: value.spaceId,
    rootNodeId: value.rootNodeId,
    rootRevision: value.rootRevision,
    treeGeneration: value.treeGeneration,
    entries: Object.freeze(entries),
  });
}

function manifest(snapshot: unknown): ZipTargetManifest {
  const zip = inspectSnapshot(snapshot);
  const targets = zip.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) =>
      Object.freeze({
        spaceId: zip.spaceId,
        nodeId: entry.nodeId,
        blobId: entry.blobId!,
        purpose: "zip" as const,
        size: entry.size,
      }),
    );
  let outputBytes: number;
  try {
    outputBytes = storeZipSize(
      zip.entries.map((entry) => ({
        name: entry.path,
        size: entry.size,
        directory: entry.kind === "folder",
        open: async () => {
          throw new Error("zip_measurement_opened_source");
        },
      })),
    );
  } catch {
    throw new Error("invalid_zip_manifest");
  }
  return Object.freeze({
    v: 2,
    serializer: "store-v1",
    zip,
    targets: Object.freeze(targets),
    outputBytes,
  });
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function encodeZipManifest(snapshot: ZipSnapshot): Promise<EncodedTargetManifest> {
  const value = manifest(snapshot);
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_BYTES) throw new Error("invalid_zip_manifest");
  return Object.freeze({ json, hash: await digest(bytes), totalBytes: value.outputBytes });
}

/** Recompute paths, targets and serializer framing; redundant fields cannot mint budget bytes. */
export function parseZipManifest(value: unknown, totalBytes: number): ZipTargetManifest {
  if (
    !record(value, "outputBytes,serializer,targets,v,zip") ||
    value.v !== 2 ||
    value.serializer !== "store-v1"
  )
    throw new Error("invalid_zip_manifest");
  const canonical = manifest(value.zip);
  if (
    value.outputBytes !== canonical.outputBytes ||
    totalBytes !== canonical.outputBytes ||
    JSON.stringify(value.targets) !== JSON.stringify(canonical.targets) ||
    JSON.stringify(value.zip) !== JSON.stringify(canonical.zip)
  )
    throw new Error("invalid_zip_manifest");
  return canonical;
}

/** Reissuing identical archive bytes never grants another allowance, even after tree revisions. */
export async function zipBudgetKey(value: ZipTargetManifest): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      serializer: value.serializer,
      entries: value.zip.entries.map(({ path, kind, blobId, size }) => ({
        path,
        kind,
        blobId,
        size,
      })),
    }),
  );
  return `zip:archive:${await digest(bytes)}`;
}
