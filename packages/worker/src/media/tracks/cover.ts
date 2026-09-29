import { ascii, ImageFormatError, valid, view } from "../images/reader";
import type { TrackTags } from "./common";

export const AUDIO_COVER_BYTES = 20_000_000;
export interface EmbeddedCover {
  readonly bytes: Uint8Array;
  readonly type: 0 | 3;
}

/** Prefer the first front cover to an unclassified picture. Image bytes are inspected separately. */
export function offerCover(tags: TrackTags, bytes: Uint8Array, type: number) {
  if (
    (type !== 0 && type !== 3) ||
    !bytes.length ||
    bytes.length > AUDIO_COVER_BYTES ||
    tags.cover?.type === 3 ||
    tags.cover?.type === type
  )
    return;
  tags.cover = { bytes: bytes.slice(), type };
}

/** A malformed optional picture must not erase otherwise valid audio metadata. Never fetch URLs. */
export function optionalCover(parse: () => void) {
  try {
    parse();
  } catch (error) {
    if (!(error instanceof ImageFormatError || error instanceof RangeError)) throw error;
  }
}

/** FLAC PICTURE layout, also used by the base64 Vorbis/Opus comment. */
export function flacCover(bytes: Uint8Array, tags: TrackTags) {
  if (tags.cover?.type === 3) return;
  optionalCover(() => {
    valid(bytes.length >= 32);
    const d = view(bytes),
      type = d.getUint32(0),
      mimeLength = d.getUint32(4);
    valid(mimeLength > 0 && mimeLength <= 128 && 8 + mimeLength + 4 <= bytes.length);
    if (ascii(bytes, 8, mimeLength) === "-->") return;
    let at = 8 + mimeLength;
    const descriptionLength = d.getUint32(at);
    at += 4;
    valid(descriptionLength <= 4096 && at + descriptionLength + 20 <= bytes.length);
    at += descriptionLength + 16; // declared geometry/depth/palette is never trusted
    const length = d.getUint32(at);
    at += 4;
    valid(length === bytes.length - at);
    offerCover(tags, bytes.subarray(at), type);
  });
}

export function commentCover(bytes: Uint8Array, tags: TrackTags) {
  if (tags.cover?.type === 3 || bytes.length > Math.ceil((AUDIO_COVER_BYTES + 4256) / 3) * 4)
    return;
  const prefix = "METADATA_BLOCK_PICTURE=";
  if (bytes.length <= prefix.length || ascii(bytes, 0, prefix.length).toUpperCase() !== prefix)
    return;
  const encoded = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    bytes.subarray(prefix.length),
  );
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
  const decoded = atob(encoded);
  if (btoa(decoded) !== encoded) return;
  flacCover(
    Uint8Array.from(decoded, (c) => c.charCodeAt(0)),
    tags,
  );
}

export function id3Cover(bytes: Uint8Array, tags: TrackTags, version: number) {
  if (tags.cover?.type === 3) return;
  optionalCover(() => {
    valid(bytes.length >= 6);
    const encoding = bytes[0]!;
    valid(encoding <= (version === 4 ? 3 : 1));
    let at: number;
    if (version === 2) {
      if (ascii(bytes, 1, 3) === "-->") return;
      at = 4;
    } else {
      const end = bytes.indexOf(0, 1);
      valid(end > 1 && end <= 129);
      if (ascii(bytes, 1, end - 1) === "-->") return;
      at = end + 1;
    }
    const type = bytes[at++];
    valid(type !== undefined);
    const end = Math.min(bytes.length, at + 4096),
      width = encoding === 1 || encoding === 2 ? 2 : 1;
    for (; at + width <= end; at += width) {
      if (bytes[at] === 0 && (width === 1 || bytes[at + 1] === 0)) {
        offerCover(tags, bytes.subarray(at + width), type);
        return;
      }
    }
  });
}
