/** Opaque provider value: never infer its age or database from its contents. */
export function restoreBookmark(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value))
    throw new Error("database_restore_invalid_bookmark");
  return value;
}

/** Require an explicit canonical UTC timestamp; never default to the current bookmark. */
export function restoreBookmarkTimestamp(value: unknown, latest: number): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isSafeInteger(Date.parse(value)) ||
    Date.parse(value) < 0 ||
    Date.parse(value) > latest ||
    new Date(value).toISOString() !== value
  )
    throw new Error("database_restore_invalid_timestamp");
  return value;
}

export interface RestoreBookmarkObservation {
  bookmark: string;
  timestamp: string;
}

export function restoreBookmarkObservation(
  input: unknown,
  expectedBookmark: string,
  latest: number,
): RestoreBookmarkObservation {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("database_restore_invalid_bookmark");
  const value = input as Record<string, unknown>;
  const bookmark = restoreBookmark(value.bookmark);
  if (bookmark !== expectedBookmark) throw new Error("database_restore_bookmark_mismatch");
  return { bookmark, timestamp: restoreBookmarkTimestamp(value.timestamp, latest) };
}
