import { AUDIO_CODEC_MIME } from "../media/tracks/audioSql";
import { TRACK_METADATA_GENERATOR } from "../media/tracks/common";
import { audioSearchTags } from "../search/audio";

export interface CopyAudioInput {
  readonly nodeId: string;
  readonly blobId: string;
  readonly generator: string;
  readonly durationMs: number | null;
  readonly codec: string;
  readonly titleExtracted: string | null;
  readonly artistExtracted: string | null;
  readonly albumExtracted: string | null;
  readonly titleOverride: string | null;
  readonly artistOverride: string | null;
  readonly albumOverride: string | null;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
}
export interface CopyAudio extends CopyAudioInput {
  readonly search: ReturnType<typeof audioSearchTags>;
}
// Fixed application identifiers; also fixes the JSON order used by the acceptance proof.
export const COPY_AUDIO_FIELDS = {
  nodeId: "node_id",
  blobId: "blob_id",
  generator: "generator_version",
  durationMs: "duration_ms",
  codec: "codec",
  titleExtracted: "title_extracted",
  artistExtracted: "artist_extracted",
  albumExtracted: "album_extracted",
  titleOverride: "title_override",
  artistOverride: "artist_override",
  albumOverride: "album_override",
  trackNumber: "track_number",
  discNumber: "disc_number",
} as const;
export const COPY_AUDIO_JSON = `json_object(${Object.entries(COPY_AUDIO_FIELDS)
  .map(([key, column]) => `'${key}',a.${column}`)
  .join(",")})`;
export const COPY_AUDIO_MATCH = `n.kind='file' AND a.blob_id=n.current_blob_id
  AND a.generator_version='${TRACK_METADATA_GENERATOR}' AND b.owner_id=n.owner_id
  AND b.state IN ('committed','gc_candidate') AND ${AUDIO_CODEC_MIME}`;
export const COPY_AUDIO_AT_NODE = `(SELECT ${COPY_AUDIO_JSON} FROM node_audio a
  JOIN blobs b ON b.id=a.blob_id WHERE a.node_id=n.id AND ${COPY_AUDIO_MATCH})`;

export function copyAudioInput(audio: CopyAudioInput): CopyAudioInput {
  return Object.fromEntries(
    Object.keys(COPY_AUDIO_FIELDS).map((key) => [key, audio[key as keyof CopyAudioInput]]),
  ) as unknown as CopyAudioInput;
}
/** Rebuild from the accepted raw values, including legacy caches; never trust a source cache. */
export function freezeCopyAudio(input: CopyAudioInput): CopyAudio {
  const raw = copyAudioInput(input);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.nodeId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.blobId) ||
    raw.generator !== TRACK_METADATA_GENERATOR ||
    !["opus", "mp3", "flac", "pcm", "vorbis", "aac"].includes(raw.codec) ||
    [raw.durationMs, raw.trackNumber, raw.discNumber].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    [
      raw.titleExtracted,
      raw.artistExtracted,
      raw.albumExtracted,
      raw.titleOverride,
      raw.artistOverride,
      raw.albumOverride,
    ].some(
      (value) =>
        value !== null &&
        (typeof value !== "string" ||
          /\p{Cs}/u.test(value) ||
          new TextEncoder().encode(value).length > 1024),
    )
  )
    throw new Error("invalid_copy_audio");
  const search = audioSearchTags({
    title: raw.titleOverride ?? raw.titleExtracted,
    artist: raw.artistOverride ?? raw.artistExtracted,
    album: raw.albumOverride ?? raw.albumExtracted,
  });
  return Object.freeze({ ...raw, search });
}
