export type ByteRange =
  | { kind: "range"; offset: number; length: number }
  | { kind: "full" }
  | { kind: "unsatisfiable" };

/** Multi-range/unknown units are ignored; callers must budget the full response first. */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("invalid_length");
  if (!header?.startsWith("bytes=") || header.includes(",")) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: "unsatisfiable" };
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if (
    (start !== undefined && !Number.isSafeInteger(start)) ||
    (end !== undefined && !Number.isSafeInteger(end))
  )
    return { kind: "unsatisfiable" };
  if (start === undefined) {
    if (!end) return { kind: "unsatisfiable" };
    const length = Math.min(size, end);
    return { kind: "range", offset: size - length, length };
  }
  if (start >= size || (end !== undefined && start > end)) return { kind: "unsatisfiable" };
  return { kind: "range", offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
}
