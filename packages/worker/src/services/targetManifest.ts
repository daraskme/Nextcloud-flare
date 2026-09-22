import type { ContentPurpose } from "../auth/contentSession";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_TARGETS = 1_000;
const MAX_BLOB_BYTES = 536_870_912_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TargetEntry {
  readonly spaceId: string;
  readonly nodeId: string;
  readonly blobId: string;
  readonly purpose: ContentPurpose;
  readonly size: number;
}

export interface TargetManifest {
  readonly v: 1;
  readonly targets: readonly TargetEntry[];
}

export interface TargetManifestRecord {
  readonly id: string;
  readonly ref: string;
  readonly hash: string;
  readonly totalBytes: number;
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

export function parseTargetManifest(bytes: ArrayBuffer, totalBytes: number): TargetManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES)
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
  if (
    Object.keys(manifest).sort().join(",") !== "targets,v" ||
    manifest.v !== 1 ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0 ||
    manifest.targets.length > MAX_TARGETS
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
  return manifest as unknown as TargetManifest;
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

export function manifestContains(
  manifest: TargetManifest,
  target: Omit<TargetEntry, "size"> & { readonly size?: number },
): boolean {
  return manifest.targets.some(
    (entry) =>
      entry.spaceId === target.spaceId &&
      entry.nodeId === target.nodeId &&
      entry.blobId === target.blobId &&
      entry.purpose === target.purpose &&
      (target.size === undefined || entry.size === target.size),
  );
}
