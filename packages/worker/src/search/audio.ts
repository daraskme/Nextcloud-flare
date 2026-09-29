import type { AudioTags } from "../../../shared/src/audio";
import { SEARCH_NAME_VERSION, searchText } from "../../../shared/src/names";

// v2 caches are published together with the base index and FTS. v1 predates that connection.
export const AUDIO_SEARCH_VERSION = `audio-tags-2-${SEARCH_NAME_VERSION}`;
export const AUDIO_SEARCH_LIMITS = Object.freeze({
  fieldBytes: 1024,
  textBytes: 65536,
  tokenBytes: 196608,
  sourceBytes: 32768,
});

/** The three effective display fields, in a fixed order, bind the derived cache to its inputs. */
export function audioSearchTags(tags: AudioTags) {
  const values = [tags.title, tags.artist, tags.album],
    bytes = (value: string) => new TextEncoder().encode(value).length;
  for (const value of values)
    if (
      value !== null &&
      (typeof value !== "string" ||
        value.length > AUDIO_SEARCH_LIMITS.fieldBytes ||
        /\p{Cs}/u.test(value) ||
        bytes(value) > AUDIO_SEARCH_LIMITS.fieldBytes)
    )
      throw new Error("invalid_audio_search_tags");
  // Queries reject control characters: a field boundary cannot become a substring match.
  const projection = searchText(values.filter((value) => value !== null).join("\n")),
    source = JSON.stringify(values);
  if (
    bytes(projection.textNorm) > AUDIO_SEARCH_LIMITS.textBytes ||
    bytes(projection.tokens) > AUDIO_SEARCH_LIMITS.tokenBytes ||
    bytes(source) > AUDIO_SEARCH_LIMITS.sourceBytes
  )
    throw new Error("audio_search_projection_too_large");
  return Object.freeze({ ...projection, version: AUDIO_SEARCH_VERSION, source });
}

/** Internal SQL expressions use the fixed node_audio alias `a`. Never interpolate caller text. */
export const AUDIO_SEARCH_SOURCE =
  "json_array(COALESCE(a.title_override,a.title_extracted),COALESCE(a.artist_override,a.artist_extracted),COALESCE(a.album_override,a.album_extracted))";
export const AUDIO_SEARCH_CURRENT = `a.search_version='${AUDIO_SEARCH_VERSION}' AND a.search_source=${AUDIO_SEARCH_SOURCE}`;

// Extraction preserves same-blob overrides. Bind the computation to that exact pre-write tuple.
export const AUDIO_OVERRIDE_SNAPSHOT =
  "SELECT json_array(blob_id,title_override,artist_override,album_override) AS snapshot FROM node_audio WHERE node_id=?";
