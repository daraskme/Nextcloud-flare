import type { AudioChapter, AudioChapterSet } from "../../lib/api";

export function matchesAudioChapterSelection(
  requestedGeneration: number,
  currentGeneration: number,
  nodeId: string,
  blobId: string,
  value: AudioChapterSet,
): boolean {
  return (
    requestedGeneration === currentGeneration && value.nodeId === nodeId && value.blobId === blobId
  );
}

export function formatChapterTime(positionMs: number): string {
  const totalSeconds = Math.floor(positionMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = positionMs % 1_000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function parseChapterTime(value: string): number | null {
  const match = /^(\d{1,5}):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const milliseconds = Number((match[3] ?? "").padEnd(3, "0"));
  const result = (Number(match[1]) * 60 + Number(match[2])) * 1_000 + milliseconds;
  return Number.isSafeInteger(result) ? result : null;
}

export function updateAudioChapter(
  chapters: readonly AudioChapter[],
  id: string,
  update: Partial<Pick<AudioChapter, "positionMs" | "title">>,
): AudioChapter[] {
  return chapters.map((chapter) => (chapter.id === id ? { ...chapter, ...update } : chapter));
}

export function moveAudioChapter(
  chapters: readonly AudioChapter[],
  id: string,
  offset: -1 | 1,
): AudioChapter[] {
  const index = chapters.findIndex((chapter) => chapter.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= chapters.length) return chapters.slice();
  const result = chapters.slice();
  [result[index], result[target]] = [result[target]!, result[index]!];
  return result;
}

export function removeAudioChapter(chapters: readonly AudioChapter[], id: string): AudioChapter[] {
  return chapters.filter((chapter) => chapter.id !== id);
}

export function audioChaptersDirty(
  saved: readonly AudioChapter[],
  draft: readonly AudioChapter[],
): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

export function validAudioChapters(chapters: readonly AudioChapter[], durationMs: number): boolean {
  const encoder = new TextEncoder();
  return (
    chapters.length <= 200 &&
    chapters.every(
      (chapter) =>
        /^[A-Za-z0-9_-]{1,128}$/.test(chapter.id) &&
        Number.isInteger(chapter.positionMs) &&
        chapter.positionMs >= 0 &&
        chapter.positionMs <= durationMs &&
        encoder.encode(chapter.title).byteLength > 0 &&
        encoder.encode(chapter.title).byteLength <= 256,
    ) &&
    new Set(chapters.map((chapter) => chapter.id)).size === chapters.length
  );
}
