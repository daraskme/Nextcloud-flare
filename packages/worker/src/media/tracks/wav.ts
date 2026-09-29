import { ascii, type ImageReader, valid, view } from "../images/reader";
import { AUDIO_HEAD_BYTES, head, textTag } from "./audioCommon";
import { durationMs, type TrackMetadata, type TrackTags } from "./common";

/** RIFF WAVE PCM/IEEE float only. No codec inference from a filename or an INFO tag. */
export async function wavTracks(r: ImageReader): Promise<TrackMetadata> {
  const header = await head(r, 0, 12);
  valid(
    ascii(header, 0, 4) === "RIFF" &&
      ascii(header, 8, 4) === "WAVE" &&
      view(header).getUint32(4, true) + 8 === r.size,
  );
  let at = 12,
    rate = 0,
    align = 0,
    dataBytes: number | null = null;
  const tags: TrackTags = {};
  while (at < r.size && at + 8 <= AUDIO_HEAD_BYTES) {
    r.step();
    const h = await head(r, at, 8),
      type = ascii(h, 0, 4),
      size = view(h).getUint32(4, true);
    at += 8;
    const end = at + size + (size & 1);
    valid(end <= r.size);
    if (type === "fmt ") {
      valid(!rate && size >= 16 && size <= 4096);
      const b = await head(r, at, size),
        d = view(b);
      let format = d.getUint16(0, true);
      const channels = d.getUint16(2, true),
        bits = d.getUint16(14, true);
      rate = d.getUint32(4, true);
      align = d.getUint16(12, true);
      valid(channels > 0 && channels <= 32 && rate > 0 && rate <= 768000);
      valid(size === 16 || (size >= 18 && d.getUint16(16, true) === size - 18));
      if (format === 65534) {
        valid(size === 40 && d.getUint16(16, true) === 22);
        const precision = d.getUint16(18, true),
          mask = d.getUint32(20, true);
        valid(precision > 0 && precision <= bits);
        if (mask) valid(mask.toString(2).replaceAll("0", "").length === channels);
        format = d.getUint32(24, true);
        valid(
          b.subarray(28).every((v, i) => v === [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113][i]),
        );
        if (format === 3) valid(precision === bits);
      }
      valid(
        (format === 1 && [8, 16, 24, 32].includes(bits)) ||
          (format === 3 && [32, 64].includes(bits)),
      );
      valid(align === (channels * bits) / 8 && d.getUint32(8, true) === rate * align);
    } else if (type === "data") {
      valid(rate > 0 && dataBytes === null && size > 0 && size % align === 0);
      dataBytes = size;
    } else if (type === "LIST" && size >= 4 && end <= AUDIO_HEAD_BYTES) {
      const list = await head(r, at, 4);
      if (ascii(list) === "INFO") {
        let p = at + 4;
        while (p < at + size) {
          r.step();
          valid(p + 8 <= at + size);
          const field = await head(r, p, 8),
            n = view(field).getUint32(4, true);
          const key = (
            {
              INAM: "TITLE",
              IART: "ARTIST",
              IPRD: "ALBUM",
              ITRK: "TRACK",
              IPRT: "TRACK",
            } as Record<string, string>
          )[ascii(field, 0, 4)];
          p += 8;
          valid(p + n + (n & 1) <= at + size);
          if (key && n <= 1025) {
            const bytes = await head(r, p, n);
            try {
              textTag(
                tags,
                key,
                new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
              );
            } catch {
              /* INFO has no reliable encoding marker; omit undecodable text. */
            }
          }
          p += n + (n & 1);
        }
      }
    }
    at = end;
  }
  valid(rate > 0 && dataBytes !== null);
  return {
    media: { kind: "audio", container: "wav", codec: "pcm" },
    width: null,
    height: null,
    durationMs: durationMs(dataBytes / align, rate),
    ...tags,
  };
}
