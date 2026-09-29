import type { AudioPage, AudioTrack, PlaybackState } from "../../../shared/src/audio";

export interface AudioClient {
  readonly scope: string;
  readonly signal: AbortSignal;
  list(cursor: string | null, signal: AbortSignal): Promise<AudioPage>;
  current(id: string, signal: AbortSignal): Promise<AudioPage>;
  original(item: AudioTrack, signal: AbortSignal): Promise<{ url: string; expiresAt: number }>;
  save?(
    item: AudioTrack,
    generator: string,
    positionMs: number,
    previousUpdatedAt: number | null,
    signal: AbortSignal,
  ): Promise<PlaybackState>;
}

/** Native media keeps its original URL; only the small session receipt is materialized. */
export async function audioOriginal(
  origin: string,
  ticket: string,
  item: AudioTrack,
  signal: AbortSignal,
) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    ![item.id, item.currentBlobId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("invalid_audio_target");
  const response = await fetch(`${origin}/session`, {
    method: "POST",
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  if (!response.ok)
    throw Object.assign(new Error("audio_session_unavailable"), { status: response.status });
  const result = (await response.json()) as { expiresAt?: unknown };
  signal.throwIfAborted();
  if (
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now() ||
    result.expiresAt > Date.now() + 600000
  )
    throw new Error("invalid_audio_session");
  return { url: `${origin}/c/${item.id}/${item.currentBlobId}`, expiresAt: result.expiresAt };
}
