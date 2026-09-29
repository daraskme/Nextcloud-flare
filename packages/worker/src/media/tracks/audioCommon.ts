import { ascii, type ImageReader, valid, view } from "../images/reader";
import { type TrackTags, tag } from "./common";

export const AUDIO_HEAD_BYTES = 2097152;
export function head(r: ImageReader, at: number, length: number) {
  valid(at >= 0 && length >= 0 && at + length <= AUDIO_HEAD_BYTES);
  return r.read(at, length);
}
export function textTag(tags: TrackTags, name: string, text: string) {
  tag(tags, name, new TextEncoder().encode(text.replace(/\0+$/, "")));
}
/** FLAC's Vorbis comments omit the framing bit used by Vorbis packets. */
export function vorbisComments(bytes: Uint8Array, tags: TrackTags, r: ImageReader, exact = true) {
  valid(bytes.length >= 8);
  const d = view(bytes);
  let at = 4 + d.getUint32(0, true);
  valid(at + 4 <= bytes.length);
  const count = d.getUint32(at, true);
  at += 4;
  valid(count <= 4096);
  for (let i = 0; i < count; i++) {
    r.step();
    valid(at + 4 <= bytes.length);
    const size = d.getUint32(at, true);
    at += 4;
    valid(at + size <= bytes.length);
    if (size <= 1100) {
      const field = bytes.subarray(at, at + size),
        equals = field.indexOf(61);
      if (equals > 0 && equals <= 64)
        tag(tags, ascii(field, 0, equals), field.subarray(equals + 1));
    }
    at += size;
  }
  if (exact) valid(at === bytes.length);
  return at;
}
