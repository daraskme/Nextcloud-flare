import { ascii, type ImageReader, valid, view } from "../images/reader";
import {
  av1Configuration,
  durationMs,
  opusConfiguration,
  type TrackMetadata,
  type TrackTags,
  tag,
} from "./common";

interface Element {
  id: number;
  start: number;
  end: number;
  unknown: boolean;
}
function vint(bytes: Uint8Array, at: number, id: boolean) {
  const first = bytes[at];
  valid(first);
  let length = 1,
    mask = 128;
  while (!(first & mask)) {
    mask >>>= 1;
    length++;
  }
  valid(length <= (id ? 4 : 8) && at + length <= bytes.length);
  let n = BigInt(id ? first : first & (mask - 1));
  for (let i = 1; i < length; i++) n = n * 256n + BigInt(bytes[at + i]!);
  const unknown = !id && n === (1n << BigInt(7 * length)) - 1n;
  valid(unknown || n <= BigInt(Number.MAX_SAFE_INTEGER));
  return { value: unknown ? 0 : Number(n), length, unknown };
}
async function element(r: ImageReader, at: number, end: number): Promise<Element> {
  r.step();
  valid(end > at && end <= r.size);
  const head = await r.read(at, Math.min(12, end - at)),
    id = vint(head, 0, true),
    size = vint(head, id.length, false);
  const start = at + id.length + size.length,
    last = size.unknown ? end : start + size.value;
  valid(Number.isSafeInteger(last) && last <= end && last >= start);
  return { id: id.value, start, end: last, unknown: size.unknown };
}
async function children(r: ImageReader, e: Element) {
  const list: Element[] = [];
  for (let at = e.start; at < e.end; ) {
    const next = await element(r, at, e.end);
    valid(!next.unknown);
    list.push(next);
    at = next.end;
  }
  return list;
}
function one(list: Element[], id: number, optional = false) {
  const found = list.filter((e) => e.id === id);
  valid(found.length <= 1 && (optional || found.length === 1));
  return found[0];
}
async function uint(r: ImageReader, e: Element | undefined, fallback?: number) {
  if (!e) {
    valid(fallback !== undefined);
    return fallback;
  }
  valid(e.end - e.start >= 1 && e.end - e.start <= 8);
  let value = 0n;
  for (const b of await r.read(e.start, e.end - e.start)) value = value * 256n + BigInt(b);
  valid(value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}
async function bytes(r: ImageReader, e: Element, limit = 1024) {
  valid(e.end - e.start <= limit);
  return r.read(e.start, e.end - e.start);
}

/** Parse Info/Tracks/Tags, then stop before media Clusters; their payload is never materialized. */
export async function webmTracks(r: ImageReader): Promise<TrackMetadata> {
  const header = await element(r, 0, r.size);
  valid(header.id === 0x1a45dfa3 && !header.unknown && header.end <= 4096);
  const h = await children(r, header);
  valid(ascii(await bytes(r, one(h, 0x4282)!)) === "webm");
  valid(
    (await uint(r, one(h, 0x42f7, true), 1)) === 1 && (await uint(r, one(h, 0x4285, true), 1)) <= 4,
  );
  valid(
    (await uint(r, one(h, 0x42f2, true), 4)) <= 4 && (await uint(r, one(h, 0x42f3, true), 8)) <= 8,
  );
  const segment = await element(r, header.end, r.size);
  valid(segment.id === 0x18538067 && segment.end === r.size);
  let info: Element[] | undefined,
    tracks: Element[] | undefined,
    tagEntries: Element[] = [],
    cluster = false;
  for (let at = segment.start; at < segment.end; ) {
    const e = await element(r, at, segment.end);
    if (e.id === 0x1f43b675) {
      cluster = e.end > e.start;
      break;
    }
    valid(!e.unknown);
    if (e.id === 0x1549a966) {
      valid(!info);
      info = await children(r, e);
    }
    if (e.id === 0x1654ae6b) {
      valid(!tracks);
      tracks = await children(r, e);
    }
    if (e.id === 0x1254c367) {
      valid(tagEntries.length === 0);
      tagEntries = await children(r, e);
    }
    at = e.end;
  }
  valid(info && tracks && cluster);
  const scale = await uint(r, one(info, 0x2ad7b1, true), 1000000),
    dur = one(info, 0x4489, true);
  valid(scale > 0);
  let duration: number | null = null;
  if (dur) {
    const b = await bytes(r, dur, 8);
    valid(b.length === 4 || b.length === 8);
    duration = durationMs(
      (b.length === 4 ? view(b).getFloat32(0) : view(b).getFloat64(0)) * scale,
      1000000000,
    );
  }
  const entries = tracks.filter((e) => e.id === 0xae);
  valid(entries.length > 0 && entries.length <= 16);
  let video:
      | { width: number; height: number; configuration: ReturnType<typeof av1Configuration> }
      | undefined,
    audio = false;
  const ids = new Set<number>(),
    uids = new Set<string>();
  const tags: TrackTags = {};
  const title = one(info, 0x7ba9, true);
  if (title && title.end - title.start <= 1024) tag(tags, "TITLE", await bytes(r, title));
  for (const entry of entries) {
    const fields = await children(r, entry),
      id = await uint(r, one(fields, 0xd7));
    valid(id > 0 && !ids.has(id));
    ids.add(id);
    const uid = await bytes(r, one(fields, 0x73c5)!, 8);
    valid(uid.length > 0 && uid.some((b) => b !== 0));
    const uidKey = Array.from(uid, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^0+(?=.)/, "");
    valid(!uids.has(uidKey));
    uids.add(uidKey);
    valid(!one(fields, 0x6d80, true)); // ContentEncodings (compression/encryption) is not inline media.
    const kind = await uint(r, one(fields, 0x83)),
      codec = ascii(await bytes(r, one(fields, 0x86)!));
    const config = await bytes(r, one(fields, 0x63a2)!, 65536);
    if (kind === 1) {
      valid(!video && codec === "V_AV1");
      const display = await children(r, one(fields, 0xe0)!);
      const width = await uint(r, one(display, 0xb0)),
        height = await uint(r, one(display, 0xba));
      valid(width > 0 && height > 0 && width <= 65535 && height <= 65535);
      video = { width, height, configuration: av1Configuration(config) };
    } else {
      valid(kind === 2 && !audio && codec === "A_OPUS");
      const channels = opusConfiguration(config).channels,
        sound = await children(r, one(fields, 0xe1)!);
      valid((await uint(r, one(sound, 0x9f, true), 1)) === channels);
      audio = true;
      const name = one(fields, 0x536e, true);
      if (name && name.end - name.start <= 1024) tag(tags, "TITLE", await bytes(r, name));
    }
  }
  for (const entry of tagEntries.filter((e) => e.id === 0x7373)) {
    const fields = await children(r, entry),
      targets = one(fields, 0x63c0, true);
    if (targets) {
      const values = await children(r, targets),
        track = one(values, 0x63c5, true);
      if (track) {
        const b = await bytes(r, track, 8);
        const key = Array.from(b, (x) => x.toString(16).padStart(2, "0"))
          .join("")
          .replace(/^0+(?=.)/, "");
        if (b.some((x) => x !== 0) && !uids.has(key)) continue;
      }
    }
    for (const simple of fields.filter((e) => e.id === 0x67c8)) {
      const values = await children(r, simple),
        name = one(values, 0x45a3),
        value = one(values, 0x4487, true);
      if (value && value.end - value.start <= 1024)
        tag(tags, ascii(await bytes(r, name!)), await bytes(r, value));
    }
  }
  return {
    media: video
      ? {
          kind: "video",
          container: "webm",
          codec: "av1",
          configuration: video.configuration,
          audio: audio ? "opus" : null,
        }
      : { kind: "audio", container: "webm", codec: "opus" },
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: duration,
    ...tags,
  };
}
