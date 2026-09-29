export const MEDIA_EXTRACTION_GENERATOR = "media-metadata-v1";
export type ExtractedMediaKind = "image" | "video" | "audio" | "unsupported";
export interface MediaExtractionReceipt {
  nodeId: string;
  blobId: string;
  generator: typeof MEDIA_EXTRACTION_GENERATOR;
  state: "pending" | "ready" | "unsupported" | "failed";
  kind: ExtractedMediaKind | null;
}

export function mediaExtractionReceipt(
  value: unknown,
  nodeId: string,
  blobId: string,
): MediaExtractionReceipt {
  const r = value as Partial<MediaExtractionReceipt> | null;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    r.nodeId !== nodeId ||
    r.blobId !== blobId ||
    r.generator !== MEDIA_EXTRACTION_GENERATOR ||
    !["pending", "ready", "unsupported", "failed"].includes(r.state ?? "") ||
    (r.state === "ready"
      ? !["audio", "video", "image"].includes(r.kind ?? "")
      : r.state === "unsupported"
        ? r.kind !== "unsupported"
        : r.kind !== null)
  )
    throw new Error("invalid_media_receipt");
  return r as MediaExtractionReceipt;
}
