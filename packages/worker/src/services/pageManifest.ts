import { ARCHIVE_GENERATOR } from "../media/archive/codec";
import { ARCHIVE_LIMITS } from "../media/archive/format";
import { hex } from "../platform/stream";
import type { EncodedTargetManifest, TargetEntry } from "./targetManifest";

/** One book per session: allowance is expanded image bytes, bound to one immutable index. */
export interface PageTarget extends TargetEntry {
  readonly purpose: "page";
  readonly archiveId: string;
  readonly generator: typeof ARCHIVE_GENERATOR;
  readonly indexHash: string;
  readonly indexBytes: number;
  readonly pageCount: number;
  readonly pageBytes: readonly number[];
}
export interface PageManifest {
  readonly v: 4;
  readonly targets: readonly [PageTarget];
}
export function parsePageManifest(
  value: Record<string, unknown>,
  totalBytes: number,
): PageManifest {
  if (
    Object.keys(value).sort().join(",") !== "targets,v" ||
    value.v !== 4 ||
    !Array.isArray(value.targets) ||
    value.targets.length !== 1
  )
    throw new Error("invalid_page_manifest");
  const t = value.targets[0];
  if (
    !t ||
    typeof t !== "object" ||
    Array.isArray(t) ||
    Object.keys(t).sort().join(",") !==
      "archiveId,blobId,generator,indexBytes,indexHash,nodeId,pageBytes,pageCount,purpose,size,spaceId" ||
    ![t.spaceId, t.nodeId, t.blobId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    ) ||
    typeof t.archiveId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.archiveId) ||
    t.purpose !== "page" ||
    t.generator !== ARCHIVE_GENERATOR ||
    typeof t.indexHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(t.indexHash) ||
    !Number.isSafeInteger(t.indexBytes) ||
    t.indexBytes < 1 ||
    t.indexBytes > ARCHIVE_LIMITS.indexBytes ||
    !Number.isSafeInteger(t.pageCount) ||
    t.pageCount < 1 ||
    t.pageCount > ARCHIVE_LIMITS.entries ||
    !Array.isArray(t.pageBytes) ||
    t.pageBytes.length !== t.pageCount ||
    !t.pageBytes.every(
      (n: unknown) =>
        typeof n === "number" &&
        Number.isSafeInteger(n) &&
        n >= 0 &&
        n <= ARCHIVE_LIMITS.entryBytes,
    ) ||
    t.pageBytes.reduce((sum: number, n: number) => sum + n, 0) !== t.size ||
    !Number.isSafeInteger(t.size) ||
    t.size < 0 ||
    t.size > ARCHIVE_LIMITS.totalBytes ||
    t.size !== totalBytes
  )
    throw new Error("invalid_page_manifest");
  const target: PageTarget = Object.freeze({
    spaceId: t.spaceId,
    nodeId: t.nodeId,
    blobId: t.blobId,
    purpose: "page",
    size: t.size,
    archiveId: t.archiveId,
    generator: ARCHIVE_GENERATOR,
    indexHash: t.indexHash,
    indexBytes: t.indexBytes,
    pageCount: t.pageCount,
    pageBytes: Object.freeze([...t.pageBytes]),
  });
  return Object.freeze({ v: 4, targets: Object.freeze([target] as const) });
}
export async function encodePageManifest(target: PageTarget): Promise<EncodedTargetManifest> {
  const manifest = parsePageManifest({ v: 4, targets: [target] }, target.size);
  const json = JSON.stringify(manifest);
  return {
    json,
    hash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))),
    totalBytes: target.size,
  };
}
