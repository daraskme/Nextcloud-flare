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

/** An empty server window is continuation, not an empty folder. Bound each user action. */
export async function readAudioPage(
  client: AudioClient,
  previous: AudioPage | null,
  signal: AbortSignal,
) {
  let page = previous;
  const priorCount = previous?.items.length ?? 0;
  for (let requests = 0; requests < 3; requests++) {
    const next = await client.list(page?.nextCursor ?? null, signal);
    signal.throwIfAborted();
    if (
      page &&
      (page.generator !== next.generator ||
        page.treeGeneration !== next.treeGeneration ||
        page.rootId !== next.rootId)
    )
      throw new Error("audio_list_changed");
    if (next.nextCursor && next.nextCursor === page?.nextCursor)
      throw new Error("audio_cursor_stalled");
    page = { ...next, items: [...(page?.items ?? []), ...next.items].slice(0, 2000) };
    if (page.items.length > priorCount || !page.nextCursor) return page;
  }
  return page!;
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
