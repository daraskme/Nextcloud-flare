import { mediaContentType } from "../../../../shared/src/media";
import { ImageFormatError, ImageReader, type ImageSource, valid } from "../images/reader";
import { sniffMediaContainer } from "../sniff";
import { TRACK_METADATA_LIMITS, type TrackMetadata } from "./common";
import { mp4Tracks } from "./mp4";
import { oggTracks } from "./ogg";
import { webmTracks } from "./webm";

export async function inspectTracks(source: ImageSource): Promise<TrackMetadata | null> {
  try {
    const limits: { bytes: number; reads: number; structures: number } = {
      ...TRACK_METADATA_LIMITS,
    };
    const r = new ImageReader(source, limits);
    if (r.size < 12) return null;
    const container = sniffMediaContainer(await r.read(0, Math.min(65536, r.size)))?.container;
    if (container !== "mp4") {
      limits.bytes = 2097152;
      limits.reads = 64;
      limits.structures = 4096;
    }
    const result =
      container === "mp4"
        ? await mp4Tracks(r)
        : container === "webm"
          ? await webmTracks(r)
          : container === "ogg"
            ? await oggTracks(r)
            : null;
    if (!result) return null;
    valid(mediaContentType(result.media).length < 128);
    return result;
  } catch (error) {
    if (error instanceof ImageFormatError || error instanceof RangeError) return null;
    throw error;
  }
}
