const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;

export function parseDavLockDepth(value: string | null): "0" | "infinity" {
  if (value === null) return "infinity";
  if (value === "0") return "0";
  if (value.toLowerCase() === "infinity") return "infinity";
  throw new Error("invalid_dav_lock_depth");
}

/** Select the first supported timeout from the client's preference list. */
export function parseDavTimeout(value: string | null): number {
  if (value === null) return DEFAULT_TIMEOUT_SECONDS;
  if (new TextEncoder().encode(value).byteLength > 256 || /[\r\n]/.test(value))
    throw new Error("invalid_dav_timeout");
  const candidates = value.split(",");
  if (candidates.length < 1 || candidates.length > 4) throw new Error("invalid_dav_timeout");
  for (const raw of candidates) {
    const candidate = raw.trim();
    if (/^Infinite$/i.test(candidate)) return MAX_TIMEOUT_SECONDS;
    const seconds = /^Second-(\d{1,10})$/i.exec(candidate)?.[1];
    if (seconds !== undefined) {
      const parsed = Number(seconds);
      if (Number.isSafeInteger(parsed) && parsed > 0) return Math.min(parsed, MAX_TIMEOUT_SECONDS);
    }
  }
  throw new Error("invalid_dav_timeout");
}
