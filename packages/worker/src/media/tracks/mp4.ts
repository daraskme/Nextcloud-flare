import type { MediaDescriptor } from "../../../../shared/src/media";
import { ascii, type ImageReader, valid, view } from "../images/reader";
import { aacEsds } from "./aac";
import {
  av1Configuration,
  durationMs,
  opusConfiguration,
  type TrackMetadata,
  type TrackTags,
  tag,
} from "./common";
import { offerCover, optionalCover } from "./cover";

interface Box {
  type: string;
  start: number;
  end: number;
}
function boxes(bytes: Uint8Array, start: number, end: number, r: ImageReader) {
  const result: Box[] = [],
    d = view(bytes);
  for (let at = start; at < end; ) {
    r.step();
    valid(at + 8 <= end);
    let size = d.getUint32(at),
      header = 8;
    if (size === 1) {
      valid(at + 16 <= end);
      const n = d.getBigUint64(at + 8);
      valid(n <= BigInt(end - at));
      size = Number(n);
      header = 16;
    }
    if (size === 0) size = end - at;
    valid(size >= header && at + size <= end);
    result.push({ type: ascii(bytes, at + 4, 4), start: at + header, end: at + size });
    at += size;
  }
  return result;
}
function one(list: Box[], type: string) {
  const all = list.filter((b) => b.type === type);
  valid(all.length === 1);
  return all[0]!;
}
function timing(bytes: Uint8Array, box: Box) {
  const version = bytes[box.start],
    d = view(bytes);
  valid((version === 0 || version === 1) && box.end - box.start >= (version === 1 ? 32 : 20));
  valid((d.getUint32(box.start) & 0xffffff) === 0);
  const scale = d.getUint32(box.start + (version === 1 ? 20 : 12));
  const ticks =
    version === 1 ? d.getBigUint64(box.start + 24) : BigInt(d.getUint32(box.start + 16));
  valid(scale > 0);
  if (ticks === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn) || ticks === 0n) return null;
  valid(ticks <= BigInt(Number.MAX_SAFE_INTEGER));
  return durationMs(Number(ticks), scale);
}

/** Metadata boxes only. mdat payloads are skipped by their validated integer extent. */
export async function mp4Tracks(r: ImageReader): Promise<TrackMetadata> {
  let bytes: Uint8Array | undefined,
    payload = false;
  for (let at = 0; at < r.size; ) {
    r.step();
    const head = await r.read(at, 8),
      d = view(head);
    let size = d.getUint32(0),
      header = 8;
    if (size === 1) {
      const wide = view(await r.read(at + 8, 8)).getBigUint64(0);
      valid(wide <= BigInt(r.size - at));
      size = Number(wide);
      header = 16;
    }
    if (size === 0) size = r.size - at;
    valid(size >= header && at + size <= r.size);
    const type = ascii(head, 4, 4);
    if (type === "moov") {
      valid(!bytes && size - header <= 4194304);
      bytes = await r.read(at + header, size - header);
    }
    if (type === "mdat") payload ||= size > header;
    at += size;
  }
  valid(bytes && payload);
  const d = view(bytes),
    top = boxes(bytes, 0, bytes.length, r);
  const duration = timing(bytes, one(top, "mvhd"));
  const tracks = top.filter((b) => b.type === "trak");
  valid(tracks.length > 0 && tracks.length <= 16);
  let video:
      | { width: number; height: number; configuration: ReturnType<typeof av1Configuration> }
      | undefined,
    audio: Extract<MediaDescriptor, { kind: "audio" }> | undefined;
  const ids = new Set<number>();
  for (const track of tracks) {
    const children = boxes(bytes, track.start, track.end, r),
      tkhd = one(children, "tkhd");
    const v = bytes[tkhd.start];
    valid((v === 0 || v === 1) && tkhd.end - tkhd.start >= (v === 1 ? 96 : 84));
    const id = d.getUint32(tkhd.start + (v === 1 ? 20 : 12));
    valid(id > 0 && !ids.has(id));
    ids.add(id);
    const mdia = one(children, "mdia"),
      media = boxes(bytes, mdia.start, mdia.end, r),
      hdlr = one(media, "hdlr");
    valid(hdlr.end - hdlr.start >= 24 && d.getUint32(hdlr.start) === 0);
    const kind = ascii(bytes, hdlr.start + 8, 4);
    valid(kind === "vide" || kind === "soun");
    timing(bytes, one(media, "mdhd"));
    const minf = one(media, "minf"),
      info = boxes(bytes, minf.start, minf.end, r);
    const dinf = one(info, "dinf"),
      dref = one(boxes(bytes, dinf.start, dinf.end, r), "dref");
    valid(dref.end - dref.start >= 8 && d.getUint32(dref.start) === 0);
    const refs = boxes(bytes, dref.start + 8, dref.end, r);
    valid(refs.length > 0 && refs.length <= 16 && refs.length === d.getUint32(dref.start + 4));
    // Never promote a track with an external URL/URN or an encrypted sample entry.
    for (const ref of refs)
      valid(ref.type === "url " && ref.end - ref.start === 4 && d.getUint32(ref.start) === 1);
    const stbl = one(info, "stbl"),
      stsd = one(boxes(bytes, stbl.start, stbl.end, r), "stsd");
    valid(stsd.end - stsd.start >= 8 && d.getUint32(stsd.start) === 0);
    const entries = boxes(bytes, stsd.start + 8, stsd.end, r);
    valid(entries.length === 1 && d.getUint32(stsd.start + 4) === 1);
    const entry = entries[0]!,
      s = entry.start;
    valid(entry.end - s >= 8 && d.getUint16(s + 6) > 0 && d.getUint16(s + 6) <= refs.length);
    if (kind === "vide") {
      valid(!video && entry.type === "av01" && entry.end - s >= 78);
      const config = one(boxes(bytes, s + 78, entry.end, r), "av1C"),
        width = d.getUint16(s + 24),
        height = d.getUint16(s + 26);
      valid(width > 0 && height > 0);
      video = {
        width,
        height,
        configuration: av1Configuration(bytes.subarray(config.start, config.end)),
      };
    } else {
      valid(
        !audio && entry.end - s >= 28 && d.getUint16(s + 8) === 0 && d.getUint16(s + 18) === 16,
      );
      const configs = boxes(bytes, s + 28, entry.end, r);
      valid(!configs.some((x) => x.type === "sinf"));
      if (entry.type === "Opus") {
        valid(d.getUint32(s + 24) === 48000 * 65536);
        const config = one(configs, "dOps");
        const opus = opusConfiguration(bytes.subarray(config.start, config.end), true);
        valid(opus.channels === d.getUint16(s + 16));
        audio = { kind: "audio", container: "mp4", codec: "opus" };
      } else {
        valid(entry.type === "mp4a");
        const config = one(configs, "esds"),
          aac = aacEsds(bytes.subarray(config.start, config.end), r);
        valid([aac.channels, aac.outputChannels].includes(d.getUint16(s + 16)));
        valid([aac.coreRate, aac.rate].some((rate) => d.getUint32(s + 24) === rate * 65536));
        audio = aac.media;
      }
    }
  }
  valid(video || audio);
  valid(!video || !audio || audio.codec === "opus");
  const tags: TrackTags = {};
  // Display tags and embedded artwork only; arbitrary atoms, URLs and GPS are omitted.
  const udta = top.filter((b) => b.type === "udta");
  valid(udta.length <= 1);
  if (udta[0]) {
    const metas = boxes(bytes, udta[0].start, udta[0].end, r).filter((b) => b.type === "meta");
    valid(metas.length <= 1);
    if (metas[0]) {
      const meta = metas[0];
      valid(meta.end - meta.start >= 4 && d.getUint32(meta.start) === 0);
      const lists = boxes(bytes, meta.start + 4, meta.end, r).filter((b) => b.type === "ilst");
      valid(lists.length <= 1);
      if (lists[0])
        for (const field of boxes(bytes, lists[0].start, lists[0].end, r)) {
          if (field.type === "covr" && !video) {
            optionalCover(() => {
              for (const value of boxes(bytes, field.start, field.end, r))
                if (
                  value.type === "data" &&
                  value.end - value.start > 8 &&
                  [13, 14].includes(d.getUint32(value.start))
                )
                  offerCover(tags, bytes.subarray(value.start + 8, value.end), 3);
            });
            continue;
          }
          const key = (
            { "©nam": "TITLE", "©ART": "ARTIST", "©alb": "ALBUM" } as Record<string, string>
          )[field.type];
          if (!key && field.type !== "trkn" && field.type !== "disk") continue;
          const values = boxes(bytes, field.start, field.end, r).filter((b) => b.type === "data");
          if (
            !key &&
            values.length === 1 &&
            values[0]!.end - values[0]!.start >= 14 &&
            d.getUint32(values[0]!.start) === 0
          ) {
            tags[field.type === "trkn" ? "trackNumber" : "discNumber"] ??= d.getUint16(
              values[0]!.start + 10,
            );
            continue;
          }
          if (
            key &&
            values.length === 1 &&
            values[0]!.end - values[0]!.start >= 8 &&
            d.getUint32(values[0]!.start) === 1
          )
            tag(tags, key, bytes.subarray(values[0]!.start + 8, values[0]!.end));
        }
    }
  }
  return {
    media: video
      ? {
          kind: "video",
          container: "mp4",
          codec: "av1",
          configuration: video.configuration,
          audio: audio ? "opus" : null,
        }
      : audio!,
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: duration,
    ...tags,
  };
}
