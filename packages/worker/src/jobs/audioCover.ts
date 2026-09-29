import { inspectImage } from "../media/images/inspect";
import type { TrackMetadata } from "../media/tracks/common";
import { hex } from "../platform/stream";

/** Validate the selected embedded bytes independently of their declared MIME and geometry. */
export async function inspectAudioCover(track: TrackMetadata | null) {
  const bytes = track?.media.kind === "audio" ? track.cover?.bytes : undefined;
  if (!bytes) return null;
  const image = await inspectImage({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  });
  if (!image) return null;
  return {
    image,
    cover: { bytes, sha256: hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))) },
  };
}
