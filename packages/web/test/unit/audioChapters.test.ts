import { expect, it } from "vitest";
import {
  audioChaptersDirty,
  formatChapterTime,
  matchesAudioChapterSelection,
  moveAudioChapter,
  parseChapterTime,
  removeAudioChapter,
  updateAudioChapter,
  validAudioChapters,
} from "../../src/features/audio/audioChapters";
import type { AudioChapter, AudioChapterSet } from "../../src/lib/api";

const chapters: AudioChapter[] = [
  { id: "intro", positionMs: 1_250, title: "Intro" },
  { id: "middle", positionMs: 62_005, title: "Middle" },
];

it("formats and parses exact millisecond chapter positions", () => {
  expect(formatChapterTime(62_005)).toBe("1:02.005");
  expect(parseChapterTime("1:02.005")).toBe(62_005);
  expect(parseChapterTime("0:03.5")).toBe(3_500);
  expect(parseChapterTime("1:60.000")).toBeNull();
  expect(parseChapterTime("-1:00")).toBeNull();
});

it("immutably edits, reorders, and deletes chapters", () => {
  const edited = updateAudioChapter(chapters, "intro", { title: "Opening" });
  expect(edited).not.toBe(chapters);
  expect(chapters[0]?.title).toBe("Intro");
  expect(edited[0]?.title).toBe("Opening");
  expect(moveAudioChapter(edited, "intro", 1).map(({ id }) => id)).toEqual(["middle", "intro"]);
  expect(removeAudioChapter(edited, "middle")).toEqual([
    { id: "intro", positionMs: 1_250, title: "Opening" },
  ]);
});

it("tracks dirty state and validates authoritative duration and title bytes", () => {
  expect(
    audioChaptersDirty(
      chapters,
      chapters.map((chapter) => ({ ...chapter })),
    ),
  ).toBe(false);
  expect(
    audioChaptersDirty(chapters, updateAudioChapter(chapters, "intro", { positionMs: 2 })),
  ).toBe(true);
  expect(validAudioChapters(chapters, 62_005)).toBe(true);
  expect(
    validAudioChapters(updateAudioChapter(chapters, "middle", { positionMs: 62_006 }), 62_005),
  ).toBe(false);
  expect(
    validAudioChapters(updateAudioChapter(chapters, "intro", { title: "あ".repeat(86) }), 70_000),
  ).toBe(false);
});

it("rejects late responses after selection, blob, or generation changes", () => {
  const response: AudioChapterSet = {
    nodeId: "node",
    blobId: "blob",
    durationMs: 70_000,
    revision: 1,
    chapters,
  };
  expect(matchesAudioChapterSelection(2, 2, "node", "blob", response)).toBe(true);
  expect(matchesAudioChapterSelection(1, 2, "node", "blob", response)).toBe(false);
  expect(matchesAudioChapterSelection(2, 2, "other", "blob", response)).toBe(false);
  expect(matchesAudioChapterSelection(2, 2, "node", "replacement", response)).toBe(false);
});
