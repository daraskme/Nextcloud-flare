import { LIMITS } from "@next-cloud-flare/shared/limits";
import { portableName } from "@next-cloud-flare/shared/names";
import type { ContentPurpose } from "../auth/contentSession";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_BLOB_BYTES = 536_870_912_000;
const MAX_ETAG_BYTES = 1_024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TargetEntry {
  readonly spaceId: string;
  readonly nodeId: string;
  readonly blobId: string;
  readonly purpose: ContentPurpose;
  readonly size: number;
}

export interface ZipTargetEntry {
  readonly path: string;
  readonly rootId: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly blobId: string;
  readonly size: number;
  readonly r2Etag: string;
}

export interface BlobTargetManifest {
  readonly v: 1;
  readonly targets: readonly TargetEntry[];
}

export interface ZipTargetManifest {
  readonly v: 2;
  readonly kind: "zip";
  readonly outputSize: number;
  readonly entries: readonly ZipTargetEntry[];
}

export type TargetManifest = BlobTargetManifest | ZipTargetManifest;

export interface TargetManifestRecord {
  readonly id: string;
  readonly ref: string;
  readonly hash: string;
  readonly totalBytes: number;
}

export interface EncodedTargetManifest {
  readonly json: string;
  readonly hash: string;
  readonly totalBytes: number;
}

async function encode(json: string, totalBytes: number): Promise<EncodedTargetManifest> {
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("invalid_target_manifest");
  parseTargetManifest(bytes.buffer as ArrayBuffer, totalBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ json, hash, totalBytes });
}

/** Canonical bytes for a new blob target set; the caller still owns R2/D1 publication. */
export async function encodeTargetManifest(
  targets: readonly TargetEntry[],
): Promise<EncodedTargetManifest> {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > LIMITS.zipEntries)
    throw new Error("invalid_target_manifest");
  const entries: TargetEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const target of targets) {
    if (!validTarget(target)) throw new Error("invalid_target_manifest");
    const entry = {
      spaceId: target.spaceId,
      nodeId: target.nodeId,
      blobId: target.blobId,
      purpose: target.purpose,
      size: target.size,
    };
    const key = `${entry.spaceId}/${entry.nodeId}/${entry.blobId}/${entry.purpose}`;
    if (seen.has(key)) throw new Error("invalid_target_manifest");
    seen.add(key);
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("invalid_target_manifest");
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const left = `${a.spaceId}/${a.nodeId}/${a.blobId}/${a.purpose}`;
    const right = `${b.spaceId}/${b.nodeId}/${b.blobId}/${b.purpose}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return encode(JSON.stringify({ v: 1, targets: entries }), totalBytes);
}

/** Canonical bytes retain the exact ZIP delivery order and framing-inclusive output size. */
export async function encodeZipTargetManifest(
  entries: readonly ZipTargetEntry[],
  outputSize: number,
): Promise<EncodedTargetManifest> {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > LIMITS.zipEntries ||
    !Number.isSafeInteger(outputSize) ||
    outputSize < 0 ||
    outputSize > LIMITS.zipBytes
  )
    throw new Error("invalid_target_manifest");
  const snapshot: ZipTargetEntry[] = [];
  const nodeIds = new Set<string>();
  const blobIds = new Set<string>();
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  let sourceBytes = 0;
  for (const entry of entries) {
    if (!validZipTarget(entry)) throw new Error("invalid_target_manifest");
    const path = portablePath(entry.path);
    const nodeKey = `${entry.spaceId}/${entry.nodeId}`;
    if (
      nodeIds.has(nodeKey) ||
      blobIds.has(entry.blobId) ||
      paths.has(path.path) ||
      foldedPaths.has(path.folded)
    )
      throw new Error("invalid_target_manifest");
    nodeIds.add(nodeKey);
    blobIds.add(entry.blobId);
    paths.add(path.path);
    foldedPaths.add(path.folded);
    sourceBytes += entry.size;
    if (!Number.isSafeInteger(sourceBytes)) throw new Error("invalid_target_manifest");
    snapshot.push({
      path: path.path,
      rootId: entry.rootId,
      spaceId: entry.spaceId,
      nodeId: entry.nodeId,
      blobId: entry.blobId,
      size: entry.size,
      r2Etag: entry.r2Etag,
    });
  }
  const overhead = outputSize - sourceBytes;
  if (overhead < 0 || overhead > entries.length * LIMITS.zipEntryOverheadBytes)
    throw new Error("invalid_target_manifest");
  return encode(JSON.stringify({ v: 2, kind: "zip", outputSize, entries: snapshot }), outputSize);
}

async function stage(
  bucket: R2Bucket,
  encodedManifest: Promise<EncodedTargetManifest>,
): Promise<TargetManifestRecord> {
  const value = await encodedManifest;
  const id = crypto.randomUUID();
  const ref = `target-sets/${id}`;
  const size = new TextEncoder().encode(value.json).byteLength;
  const object = await bucket.put(ref, value.json, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!object || object.size !== size) throw new Error("target_manifest_stage_failed");
  const record = Object.freeze({ id, ref, hash: value.hash, totalBytes: value.totalBytes });
  await loadTargetManifest(bucket, record);
  return record;
}

/** Stage an immutable R2 manifest for a later D1 target-set/ticket transaction. */
export function stageTargetManifest(
  bucket: R2Bucket,
  targets: readonly TargetEntry[],
): Promise<TargetManifestRecord> {
  return stage(bucket, encodeTargetManifest(targets));
}

export function stageZipTargetManifest(
  bucket: R2Bucket,
  entries: readonly ZipTargetEntry[],
  outputSize: number,
): Promise<TargetManifestRecord> {
  return stage(bucket, encodeZipTargetManifest(entries, outputSize));
}

function validTarget(value: unknown): value is TargetEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    Object.keys(target).sort().join(",") === "blobId,nodeId,purpose,size,spaceId" &&
    typeof target.spaceId === "string" &&
    ID.test(target.spaceId) &&
    typeof target.nodeId === "string" &&
    ID.test(target.nodeId) &&
    typeof target.blobId === "string" &&
    ID.test(target.blobId) &&
    ["content", "thumb", "page", "zip", "track"].includes(target.purpose as string) &&
    Number.isSafeInteger(target.size) &&
    (target.size as number) >= 0 &&
    (target.size as number) <= MAX_BLOB_BYTES
  );
}

function validZipTarget(value: unknown): value is ZipTargetEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    Object.keys(target).sort().join(",") === "blobId,nodeId,path,r2Etag,rootId,size,spaceId" &&
    typeof target.path === "string" &&
    typeof target.rootId === "string" &&
    ID.test(target.rootId) &&
    typeof target.spaceId === "string" &&
    ID.test(target.spaceId) &&
    typeof target.nodeId === "string" &&
    ID.test(target.nodeId) &&
    typeof target.blobId === "string" &&
    ID.test(target.blobId) &&
    Number.isSafeInteger(target.size) &&
    (target.size as number) >= 0 &&
    (target.size as number) <= LIMITS.zipEntryBytes &&
    typeof target.r2Etag === "string" &&
    target.r2Etag.length > 0 &&
    new TextEncoder().encode(target.r2Etag).byteLength <= MAX_ETAG_BYTES
  );
}

function portablePath(value: string): { path: string; folded: string } {
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).byteLength > LIMITS.zipPathBytes
  )
    throw new Error("invalid_target_manifest");
  const components = normalized.split("/");
  let portable;
  try {
    portable = components.map((component) => portableName(component));
  } catch {
    throw new Error("invalid_target_manifest");
  }
  const path = portable.map((component) => component.name).join("/");
  if (path !== normalized) throw new Error("invalid_target_manifest");
  return { path, folded: portable.map((component) => component.nameCi).join("/") };
}

function parseBlobManifest(
  manifest: Record<string, unknown>,
  totalBytes: number,
): BlobTargetManifest {
  if (
    Object.keys(manifest).sort().join(",") !== "targets,v" ||
    manifest.v !== 1 ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0 ||
    manifest.targets.length > LIMITS.zipEntries
  )
    throw new Error("invalid_target_manifest");
  const seen = new Set<string>();
  let sum = 0;
  for (const target of manifest.targets) {
    if (!validTarget(target)) throw new Error("invalid_target_manifest");
    const id = `${target.spaceId}/${target.nodeId}/${target.blobId}/${target.purpose}`;
    if (seen.has(id)) throw new Error("invalid_target_manifest");
    seen.add(id);
    sum += target.size;
    if (!Number.isSafeInteger(sum)) throw new Error("invalid_target_manifest");
  }
  if (sum !== totalBytes) throw new Error("invalid_target_manifest");
  return manifest as unknown as BlobTargetManifest;
}

function parseZipManifest(
  manifest: Record<string, unknown>,
  totalBytes: number,
): ZipTargetManifest {
  if (
    Object.keys(manifest).sort().join(",") !== "entries,kind,outputSize,v" ||
    manifest.v !== 2 ||
    manifest.kind !== "zip" ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > LIMITS.zipEntries ||
    !Number.isSafeInteger(manifest.outputSize) ||
    manifest.outputSize !== totalBytes ||
    totalBytes > LIMITS.zipBytes
  )
    throw new Error("invalid_target_manifest");
  const nodes = new Set<string>();
  const blobs = new Set<string>();
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  let sourceBytes = 0;
  for (const entry of manifest.entries) {
    if (!validZipTarget(entry)) throw new Error("invalid_target_manifest");
    const path = portablePath(entry.path);
    const nodeKey = `${entry.spaceId}/${entry.nodeId}`;
    if (
      nodes.has(nodeKey) ||
      blobs.has(entry.blobId) ||
      paths.has(path.path) ||
      foldedPaths.has(path.folded)
    )
      throw new Error("invalid_target_manifest");
    nodes.add(nodeKey);
    blobs.add(entry.blobId);
    paths.add(path.path);
    foldedPaths.add(path.folded);
    sourceBytes += entry.size;
    if (!Number.isSafeInteger(sourceBytes)) throw new Error("invalid_target_manifest");
  }
  const overhead = totalBytes - sourceBytes;
  if (overhead < 0 || overhead > manifest.entries.length * LIMITS.zipEntryOverheadBytes)
    throw new Error("invalid_target_manifest");
  return manifest as unknown as ZipTargetManifest;
}

export function parseTargetManifest(bytes: ArrayBuffer, totalBytes: number): TargetManifest {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_MANIFEST_BYTES ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0
  )
    throw new Error("invalid_target_manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error("invalid_target_manifest");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("invalid_target_manifest");
  const manifest = parsed as Record<string, unknown>;
  if (manifest.v === 1) return parseBlobManifest(manifest, totalBytes);
  if (manifest.v === 2) return parseZipManifest(manifest, totalBytes);
  throw new Error("invalid_target_manifest");
}

/** A content target set is an immutable, hash-pinned R2 object. */
export async function loadTargetManifest(
  bucket: R2Bucket,
  record: TargetManifestRecord,
): Promise<TargetManifest> {
  if (
    !ID.test(record.id) ||
    record.ref !== `target-sets/${record.id}` ||
    !/^[a-f0-9]{64}$/.test(record.hash) ||
    !Number.isSafeInteger(record.totalBytes) ||
    record.totalBytes < 0
  )
    throw new Error("invalid_target_manifest");
  const object = await bucket.get(record.ref);
  if (!object || object.size === 0 || object.size > MAX_MANIFEST_BYTES)
    throw new Error("invalid_target_manifest");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size) throw new Error("invalid_target_manifest");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== record.hash) throw new Error("invalid_target_manifest");
  return parseTargetManifest(bytes, record.totalBytes);
}

export function manifestTargets(manifest: TargetManifest): readonly TargetEntry[] {
  return manifest.v === 1
    ? manifest.targets
    : manifest.entries.map((entry) => ({
        spaceId: entry.spaceId,
        nodeId: entry.nodeId,
        blobId: entry.blobId,
        purpose: "zip" as const,
        size: entry.size,
      }));
}

export function manifestContains(
  manifest: TargetManifest,
  target: Omit<TargetEntry, "size"> & { readonly size?: number },
): boolean {
  if (manifest.v !== 1) return false;
  return manifest.targets.some(
    (entry) =>
      entry.spaceId === target.spaceId &&
      entry.nodeId === target.nodeId &&
      entry.blobId === target.blobId &&
      entry.purpose === target.purpose &&
      (target.size === undefined || entry.size === target.size),
  );
}
