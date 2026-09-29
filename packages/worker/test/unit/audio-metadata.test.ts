import { expect, it } from "vitest";
import { audioMetadataUpdate } from "../../src/services/audioMetadata";

const input = {
  blobId: "b",
  generator: "track-metadata-v1",
  revision: 1,
  title: "Title",
  artist: null,
  album: null,
};
it("normalizes display overrides separately from filename rules and treats whitespace as reset", () => {
  expect(
    audioMetadataUpdate({ ...input, title: '  カ\u3099 <live>/"mix"  ', artist: "  " }),
  ).toMatchObject({ title: 'ガ <live>/"mix"', artist: null });
  expect(audioMetadataUpdate({ ...input, title: "あ".repeat(341) }).title).toHaveLength(341);
});
it.each([
  { title: "あ".repeat(342) },
  { title: "x\n" },
  { title: "x\u0000" },
  { title: "\ud800" },
  { title: 123 },
  { title: undefined },
  { blobId: undefined },
  { generator: "other" },
  { revision: 0 },
  { revision: 1.5 },
  { revision: Number.MAX_SAFE_INTEGER },
])("rejects invalid metadata %j", (change) => {
  expect(() => audioMetadataUpdate({ ...input, ...change } as typeof input)).toThrow(
    "invalid_audio_metadata",
  );
});
