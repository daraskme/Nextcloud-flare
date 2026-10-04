const MAX_HEADER_BYTES = 8192;
const MAX_TAGS = 16;

type Tag = { readonly value: string; readonly weak: boolean };

function parseTags(raw: string): "*" | readonly Tag[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_HEADER_BYTES)
    throw new Error("invalid_dav_precondition");
  if (raw.trim() === "*") return "*";
  const tags: Tag[] = [];
  let offset = 0;
  while (offset < raw.length) {
    while (raw[offset] === " " || raw[offset] === "\t") offset++;
    const weak = raw.startsWith("W/", offset);
    if (weak) offset += 2;
    if (raw[offset++] !== '"') throw new Error("invalid_dav_precondition");
    const start = offset;
    while (offset < raw.length && raw[offset] !== '"') {
      const code = raw.charCodeAt(offset++);
      if (code < 0x21 || code === 0x7f) throw new Error("invalid_dav_precondition");
    }
    if (offset >= raw.length) throw new Error("invalid_dav_precondition");
    tags.push({ value: raw.slice(start, offset++), weak });
    if (tags.length > MAX_TAGS) throw new Error("invalid_dav_precondition");
    while (raw[offset] === " " || raw[offset] === "\t") offset++;
    if (offset === raw.length) break;
    if (raw[offset++] !== "," || offset === raw.length) throw new Error("invalid_dav_precondition");
  }
  if (!tags.length || /,\s*$/.test(raw)) throw new Error("invalid_dav_precondition");
  return tags;
}

/** Evaluate validators on the request URI for unsafe DAV methods. */
export function evaluateDavHttpPreconditions(
  headers: Headers,
  currentEtag: string | null,
  lastModified?: number,
): void {
  const current = currentEtag === null ? null : currentEtag.slice(1, -1);
  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) {
    const parsed = parseTags(ifMatch);
    if (
      current === null ||
      (parsed !== "*" && !parsed.some((tag) => !tag.weak && tag.value === current))
    )
      throw new Error("dav_precondition_failed");
  }
  if (ifMatch === null && lastModified !== undefined) {
    const date = headers.get("If-Unmodified-Since");
    if (date !== null) {
      const timestamp = httpDate(date);
      if (timestamp !== null && Math.floor(lastModified / 1000) > Math.floor(timestamp / 1000))
        throw new Error("dav_precondition_failed");
    }
  }
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    const parsed = parseTags(ifNoneMatch);
    if (current !== null && (parsed === "*" || parsed.some((tag) => tag.value === current)))
      throw new Error("dav_precondition_failed");
  }
}

export const evaluateDavPutHttpPreconditions = evaluateDavHttpPreconditions;

function httpDate(value: string): number | null {
  const imf =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  const obsolete =
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  const asctime =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value,
    );
  const parts =
    imf?.slice(1) ??
    obsolete?.slice(1) ??
    (asctime
      ? [asctime[2]!, asctime[1]!, asctime[6]!, asctime[3]!, asctime[4]!, asctime[5]!]
      : null);
  if (!parts) return null;
  const [day, monthName, yearText, hour, minute, second] = parts;
  const seconds = Number(second);
  if (seconds > 60) return null;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(monthName!);
  let year = Number(yearText);
  const now = new Date();
  if (obsolete) year += Math.floor(now.getUTCFullYear() / 100) * 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Math.min(seconds, 59), 0);
  if (obsolete) {
    const future = new Date(now);
    future.setUTCFullYear(now.getUTCFullYear() + 50);
    if (date.getTime() > future.getTime()) {
      year -= 100;
      date.setUTCFullYear(year);
    }
  }
  if (
    month < 0 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Math.min(seconds, 59)
  )
    return null;
  return date.getTime() + (seconds === 60 ? 1000 : 0);
}
