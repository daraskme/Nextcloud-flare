/** Original, pre-encoded media. Transcoding is not required for storage or delivery. */
export type MediaDescriptor =
  | { readonly kind: "image"; readonly codec: "avif" }
  | {
      readonly kind: "video";
      readonly container: "mp4" | "webm";
      readonly codec: "av1";
      readonly configuration: Av1Configuration;
      readonly audio: "opus" | null;
    }
  | { readonly kind: "audio"; readonly container: "ogg" | "webm" | "mp4"; readonly codec: "opus" };

export interface Av1Configuration {
  readonly profile: 0 | 1 | 2;
  readonly level: number;
  readonly tier: "M" | "H";
  readonly bitDepth: 8 | 10 | 12;
}

/** RFC 6381 / AV1 ISOBMFF §5. Values must come from the parsed track, never a filename. */
export function av1CodecString(config: Av1Configuration): string {
  if (
    ![0, 1, 2].includes(config.profile) ||
    !Number.isInteger(config.level) ||
    config.level < 0 ||
    (config.level > 23 && config.level !== 31) ||
    !["M", "H"].includes(config.tier) ||
    ![8, 10, 12].includes(config.bitDepth) ||
    (config.bitDepth === 12 && config.profile !== 2) ||
    (config.tier === "H" && config.level < 8)
  )
    throw new Error("invalid_av1_configuration");
  return `av01.${config.profile}.${String(config.level).padStart(2, "0")}${config.tier}.${String(config.bitDepth).padStart(2, "0")}`;
}

export function mediaContentType(media: MediaDescriptor): string {
  if (media.kind === "image" && media.codec === "avif") return "image/avif";
  if (
    media.kind === "audio" &&
    media.codec === "opus" &&
    ["ogg", "webm", "mp4"].includes(media.container)
  )
    return `audio/${media.container}; codecs="${media.container === "mp4" ? "Opus" : "opus"}"`;
  if (
    media.kind === "video" &&
    media.codec === "av1" &&
    ["mp4", "webm"].includes(media.container) &&
    (media.audio === null || media.audio === "opus")
  ) {
    const audio = media.audio === "opus" ? `,${media.container === "mp4" ? "Opus" : "opus"}` : "";
    return `video/${media.container}; codecs="${av1CodecString(media.configuration)}${audio}"`;
  }
  throw new Error("unsupported_media_descriptor");
}

/** Only the canonical parameters emitted by the server's bounded track parsers are accepted. */
export function parsedMediaContentType(type: string): MediaDescriptor | null {
  if (type === "image/avif") return { kind: "image", codec: "avif" };
  const audio = /^audio\/(mp4|webm|ogg); codecs="(Opus|opus)"$/.exec(type);
  if (audio) {
    const media: MediaDescriptor = {
      kind: "audio",
      codec: "opus",
      container: audio[1] as "mp4" | "webm" | "ogg",
    };
    return mediaContentType(media) === type ? media : null;
  }
  const video =
    /^video\/(mp4|webm); codecs="av01\.([0-2])\.(\d{2})([MH])\.(08|10|12)(?:,(Opus|opus))?"$/.exec(
      type,
    );
  if (!video) return null;
  try {
    const media: MediaDescriptor = {
      kind: "video",
      container: video[1] as "mp4" | "webm",
      codec: "av1",
      configuration: {
        profile: Number(video[2]) as 0 | 1 | 2,
        level: Number(video[3]),
        tier: video[4] as "M" | "H",
        bitDepth: Number(video[5]) as 8 | 10 | 12,
      },
      audio: video[6] ? "opus" : null,
    };
    return mediaContentType(media) === type ? media : null;
  } catch {
    return null;
  }
}

/** Hints for file picking only. Extension and client MIME never authorize inline delivery. */
export const PREENCODED_MEDIA_ACCEPT = ".avif,.avifs,.mp4,.m4a,.webm,.opus,.ogg,.oga";

export interface NativeMediaProbe {
  canPlayType(kind: "audio" | "video", contentType: string): "" | "maybe" | "probably";
}

/** Image decoding is checked by the actual <img> load/error; a media-element probe cannot test AVIF. */
export function playbackSupport(
  media: MediaDescriptor,
  probe: NativeMediaProbe,
): "unsupported" | "maybe" | "probably" | "unknown" {
  const type = mediaContentType(media);
  if (media.kind === "image") return "unknown";
  try {
    const result = probe.canPlayType(media.kind, type);
    return result === ""
      ? "unsupported"
      : result === "maybe" || result === "probably"
        ? result
        : "unknown";
  } catch {
    return "unknown";
  }
}

/** A failed derivative does not make a valid original AVIF unsupported. */
export function avifPreviewSource(
  derivative: "ready" | "pending" | "unsupported" | "failed",
  view: "grid" | "detail",
): "derivative" | "original" | "placeholder" {
  if (derivative === "ready") return "derivative";
  return view === "detail" ? "original" : "placeholder";
}
