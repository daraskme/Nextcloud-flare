import {
  AUDIO_PREFIX_BYTES,
  AUDIO_TAIL_BYTES,
  type AudioMetadata,
  parseId3Prefix,
  parseId3Tail,
} from "./id3";

export const AUDIO_GENERATOR_VERSION = "ncf-id3-1";

export interface AudioObjectSource {
  readonly key: string;
  readonly size: number;
  readonly r2Etag: string;
}

export type AudioInspection =
  | { readonly kind: "metadata"; readonly metadata: AudioMetadata }
  | { readonly kind: "unsupported" | "malformed" | "transient" };

function current(deadline: number): boolean {
  return Number.isSafeInteger(deadline) && Date.now() < deadline;
}

function matches(object: R2Object, source: AudioObjectSource): boolean {
  return (
    Number.isSafeInteger(object.size) &&
    object.size === source.size &&
    object.etag === source.r2Etag
  );
}

async function bytes(
  bucket: R2Bucket,
  source: AudioObjectSource,
  offset: number,
  length: number,
  deadline: number,
): Promise<Uint8Array | null> {
  if (!current(deadline)) return null;
  const object = await bucket.get(source.key, { range: { offset, length } });
  if (!current(deadline) || !object || !matches(object, source)) return null;
  const body = new Uint8Array(await object.arrayBuffer());
  if (!current(deadline) || body.byteLength !== length) return null;
  return body;
}

export async function inspectAudioObject(
  bucket: R2Bucket,
  source: AudioObjectSource,
  deadline: number,
): Promise<AudioInspection> {
  if (
    !source.key ||
    source.key.length > 1024 ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !source.r2Etag ||
    source.r2Etag.length > 256 ||
    !current(deadline)
  )
    return { kind: "transient" };
  try {
    if (source.size === 0) {
      const object = await bucket.head(source.key);
      if (!current(deadline) || !object || !matches(object, source)) return { kind: "transient" };
      return { kind: "unsupported" };
    }
    const prefixLength = Math.min(source.size, AUDIO_PREFIX_BYTES);
    const prefix = await bytes(bucket, source, 0, prefixLength, deadline);
    if (!prefix) return { kind: "transient" };
    const parsed = parseId3Prefix(prefix, source.size);
    if (parsed.kind !== "tail") return parsed;
    const tailLength = Math.min(source.size, AUDIO_TAIL_BYTES);
    const tail =
      source.size <= AUDIO_PREFIX_BYTES
        ? prefix.subarray(prefix.length - tailLength)
        : await bytes(bucket, source, source.size - tailLength, tailLength, deadline);
    if (!tail) return { kind: "transient" };
    return parseId3Tail(parsed, tail, source.size);
  } catch {
    return { kind: "transient" };
  }
}
