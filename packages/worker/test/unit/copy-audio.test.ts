import { expect, it } from "vitest";
import { AUDIO_SEARCH_VERSION } from "../../src/search/audio";
import { type CopyAudioInput, freezeCopyAudio } from "../../src/services/copyAudio";

const input: CopyAudioInput = {
  nodeId: "node",
  blobId: "blob",
  generator: "track-metadata-v1",
  codec: "opus",
  durationMs: 2000,
  trackNumber: 1,
  discNumber: null,
  titleExtracted: "原曲",
  artistExtracted: "ＡＲＴＩＳＴ",
  albumExtracted: null,
  titleOverride: "ｶﾀｶﾅ: / 作品",
  artistOverride: null,
  albumOverride: null,
};
it("freezes original and override values separately and builds a current search projection", () => {
  const audio = freezeCopyAudio(input);
  expect(audio).toMatchObject({
    titleExtracted: "原曲",
    titleOverride: "ｶﾀｶﾅ: / 作品",
    search: { textNorm: "かたかな: / 作品\nartist", version: AUDIO_SEARCH_VERSION },
  });
  expect(Object.isFrozen(audio)).toBe(true);
  expect(Object.isFrozen(audio.search)).toBe(true);
  expect(freezeCopyAudio({ ...input, titleOverride: null }).search.textNorm).toBe("原曲\nartist");
});
it.each([
  { titleExtracted: "x".repeat(1025) }, // Even an overridden extracted field must fit the snapshot.
  { titleOverride: "😀".repeat(257) },
  { artistExtracted: "\ud800" },
  { durationMs: Number.MAX_SAFE_INTEGER + 1 },
  { trackNumber: -1 },
  { discNumber: 1.5 },
  { generator: "unknown" },
  { codec: "unknown" },
  { nodeId: "" },
])("refuses invalid captured audio: %j", (bad) => {
  expect(() => freezeCopyAudio({ ...input, ...bad })).toThrow("invalid_copy_audio");
});
