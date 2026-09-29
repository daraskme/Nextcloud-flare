import {
  AUDIO_COVER_GENERATOR,
  IMAGE_OUTPUT_BYTES,
  type ImageGenerator,
  type ImageVariant,
  imageGenerator,
} from "../media/images/transform";
import type { EncodedTargetManifest, TargetEntry } from "./targetManifest";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface ThumbnailTarget extends TargetEntry {
  readonly purpose: "thumb";
  readonly imageId: string;
  readonly variant: ImageVariant;
  readonly generator: ImageGenerator;
}
export interface ThumbnailManifest {
  readonly v: 3;
  readonly targets: readonly ThumbnailTarget[];
}
export function thumbnailVariant(value: unknown): value is ImageVariant {
  return value === "sm" || value === "md" || value === "lg";
}
export function thumbnailBudgetKey(target: ThumbnailTarget) {
  return `thumb:image_${target.imageId}`;
}

export function parseThumbnailManifest(
  value: Record<string, unknown>,
  totalBytes: number,
): ThumbnailManifest {
  if (
    Object.keys(value).sort().join(",") !== "targets,v" ||
    value.v !== 3 ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 1000
  )
    throw new Error("invalid_thumbnail_manifest");
  const seen = new Set<string>(),
    generations = new Map<string, string>();
  let sum = 0;
  const targets: ThumbnailTarget[] = [];
  for (const target of value.targets) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).sort().join(",") !==
        "blobId,generator,imageId,nodeId,purpose,size,spaceId,variant" ||
      ![target.spaceId, target.nodeId, target.blobId].every(
        (s) => typeof s === "string" && ID.test(s),
      ) ||
      typeof target.imageId !== "string" ||
      !UUID.test(target.imageId) ||
      target.purpose !== "thumb" ||
      !imageGenerator(target.generator) ||
      !thumbnailVariant(target.variant) ||
      (target.generator === AUDIO_COVER_GENERATOR && target.variant === "lg") ||
      !Number.isSafeInteger(target.size) ||
      target.size < 1 ||
      target.size > IMAGE_OUTPUT_BYTES
    )
      throw new Error("invalid_thumbnail_manifest");
    const key = `${target.spaceId}/${target.nodeId}/${target.blobId}/${target.variant}`;
    const generation = JSON.stringify([
      target.blobId,
      target.variant,
      target.generator,
      target.size,
    ]);
    if (
      seen.has(key) ||
      (generations.has(target.imageId) && generations.get(target.imageId) !== generation)
    )
      throw new Error("invalid_thumbnail_manifest");
    seen.add(key);
    generations.set(target.imageId, generation);
    sum += target.size;
    targets.push(
      Object.freeze({
        spaceId: target.spaceId,
        nodeId: target.nodeId,
        blobId: target.blobId,
        purpose: "thumb",
        size: target.size,
        imageId: target.imageId,
        variant: target.variant,
        generator: target.generator,
      }),
    );
  }
  if (!Number.isSafeInteger(sum) || sum !== totalBytes)
    throw new Error("invalid_thumbnail_manifest");
  return Object.freeze({ v: 3, targets: Object.freeze(targets) });
}
export async function encodeThumbnailManifest(
  targets: readonly ThumbnailTarget[],
): Promise<EncodedTargetManifest> {
  const totalBytes = targets.reduce((sum, target) => sum + target.size, 0);
  const manifest = parseThumbnailManifest({ v: 3, targets }, totalBytes);
  const sorted = [...manifest.targets].sort((a, b) => {
    const key = (t: ThumbnailTarget) => `${t.spaceId}/${t.nodeId}/${t.blobId}/${t.variant}`;
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
  const json = JSON.stringify({ v: 3, targets: sorted }),
    bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > 1048576) throw new Error("invalid_thumbnail_manifest");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  return Object.freeze({ json, hash, totalBytes });
}
