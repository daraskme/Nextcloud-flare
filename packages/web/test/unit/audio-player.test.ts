import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AudioPage, AudioTrack } from "../../../shared/src/audio";
import type { AudioClient } from "../../src/public-share/audioClient";
import { AudioPlayer } from "../../src/public-share/audioPlayer";

class Media extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 90;
  volume = 1;
  paused = true;
  ended = false;
  preload = "";
  crossOrigin = "";
  loads = 0;
  canPlayType = vi.fn(() => "probably");
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  removeAttribute() {
    this.src = "";
  }
  getAttribute() {
    return this.src || null;
  }
  load() {
    this.loads++;
    this.currentTime = 0;
    this.ended = false;
    if (this.src) Promise.resolve().then(() => this.dispatchEvent(new Event("loadedmetadata")));
  }
}
function track(id = "one"): AudioTrack {
  return {
    id,
    name: `${id}.opus`,
    currentBlobId: `blob-${id}`,
    mime: 'audio/ogg; codecs="opus"',
    durationMs: 90000,
    title: id,
    artist: null,
    album: null,
    trackNumber: null,
    discNumber: null,
    playback: null,
  };
}
const items = [track(), track("two")];
function page(tracks = items): AudioPage {
  return {
    rootId: "root",
    treeGeneration: 1,
    generator: "track-metadata-v1",
    items: tracks,
    nextCursor: null,
    limitReached: false,
    trackLimit: 2000,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const players: AudioPlayer[] = [];
function fixture(publicRead = false) {
  const media = new Media();
  const player = new AudioPlayer(media as unknown as HTMLAudioElement);
  players.push(player);
  const lifetime = new AbortController();
  const saved = new Map<string, { positionMs: number; updatedAt: number }>();
  const client: AudioClient = {
    scope: "owner:root",
    signal: lifetime.signal,
    list: vi.fn(async () => page()),
    current: vi.fn(async (id) => page([{ ...track(id), playback: saved.get(id) ?? null }])),
    original: vi.fn(async (item) => ({
      url: `https://content.example/c/${item.id}/${item.currentBlobId}`,
      expiresAt: Date.now() + 300000,
    })),
    ...(!publicRead
      ? {
          save: vi.fn(
            async (
              item: AudioTrack,
              _generator: string,
              positionMs: number,
              previousUpdatedAt: number | null,
            ) => {
              if ((saved.get(item.id)?.updatedAt ?? null) !== previousUpdatedAt)
                throw { status: 409 };
              const result = {
                positionMs,
                updatedAt: Math.max(Date.now(), (previousUpdatedAt ?? 0) + 1),
              };
              saved.set(item.id, result);
              return result;
            },
          ),
        }
      : {}),
  };
  return {
    media,
    player,
    client,
    lifetime,
    saved,
    select: () => player.select(client, page(), items[0]!),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
it("refreshes edited display tags without reloading the native source or changing playback position", async () => {
  const f = fixture();
  await f.select();
  f.media.currentTime = 18;
  const loads = f.media.loads,
    src = f.media.src,
    selection = f.player.getSelectionSnapshot();
  f.player.updateQueue(
    f.client,
    page([{ ...items[0]!, title: "edited", artist: "new artist" }, items[1]!]),
  );
  expect(f.player.getSnapshot().track).toMatchObject({ title: "edited", artist: "new artist" });
  expect(f.media.loads).toBe(loads);
  expect(f.media.src).toBe(src);
  expect(f.media.currentTime).toBe(18);
  expect(f.player.getSelectionSnapshot()).toBe(selection);
  f.player.updateQueue(
    f.client,
    page([{ ...items[0]!, currentBlobId: "replacement", title: "wrong original" }]),
  );
  expect(f.player.getSnapshot().track?.title).toBe("edited");
  f.player.refreshMetadata(
    f.client,
    page([{ ...items[0]!, title: "edited beyond the first page" }]),
  );
  expect(f.player.getSnapshot().track?.title).toBe("edited beyond the first page");
  expect(f.media.loads).toBe(loads);
  expect(f.media.currentTime).toBe(18);
  f.player.refreshMetadata(
    { ...f.client, scope: "other" },
    page([{ ...items[0]!, title: "other scope" }]),
  );
  expect(f.player.getSnapshot().track?.title).toBe("edited beyond the first page");
});
afterEach(() => {
  for (const p of players.splice(0)) p.dispose();
  vi.useRealTimers();
});

it.each(["close", "next track", "logout"])(
  "discards a late cover response after %s",
  async (action) => {
    const f = fixture(),
      body = deferred<Blob>();
    let request: AbortSignal | undefined;
    const load = vi.fn(async (_item: AudioTrack, signal: AbortSignal) => {
      request = signal;
      return body.promise;
    });
    f.client.prepareCovers = vi.fn(async () => load);
    await f.select();
    const result = f.player.cover(items[0]!, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow();
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    if (action === "close") await f.player.close(false);
    else if (action === "next track") await f.player.skip(1);
    else f.lifetime.abort();
    expect(request?.aborted).toBe(true);
    // Simulate a transport that completes despite cancellation: these bytes must not revive artwork.
    body.resolve(new Blob(["late"]));
    await rejected;
    expect(f.player.getSnapshot().track?.id).not.toBe(items[0]!.id);
  },
);

it("rejects a cover for a different original and stops before GET when preparation returns after close", async () => {
  const f = fixture(),
    prepared = deferred<(item: AudioTrack, signal: AbortSignal) => Promise<Blob>>();
  const load = vi.fn(async () => new Blob(["cover"]));
  f.client.prepareCovers = vi.fn(async () => prepared.promise);
  await f.select();
  await expect(
    f.player.cover({ ...items[0]!, currentBlobId: "replaced" }, new AbortController().signal),
  ).rejects.toThrow("cover_unavailable");
  expect(f.client.prepareCovers).not.toHaveBeenCalled();
  const result = f.player.cover(items[0]!, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow();
  await f.player.close(false);
  prepared.resolve(load);
  await rejected;
  expect(load).not.toHaveBeenCalled();
});

it("resumes the current user's position, checkpoints, pauses and serializes next-track writes", async () => {
  const f = fixture();
  f.saved.set("one", { positionMs: 12000, updatedAt: 1 });
  await f.select();
  expect(f.media.currentTime).toBe(12);
  expect(f.media.paused).toBe(false);
  f.media.currentTime = 28;
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.saved.get("one")?.positionMs).toBe(28000);
  f.media.currentTime = 31;
  f.media.pause();
  await f.player.flush();
  expect(f.saved.get("one")?.positionMs).toBe(31000);
  await f.player.skip(1);
  expect(f.player.getSnapshot().track?.id).toBe("two");
  f.media.currentTime = 3;
  await f.player.skip(-1);
  expect(f.media.currentTime).toBe(31);
  expect(f.saved.get("two")?.positionMs).toBe(3000);
});
it("keeps the list selection stable during playback updates and changes it on navigation or scope loss", async () => {
  const f = fixture(true);
  const observed: unknown[] = [];
  f.player.subscribe(() => {
    const selection = f.player.getSelectionSnapshot();
    const current = f.player.getSnapshot();
    expect(selection).toEqual({ scope: current.scope, trackId: current.track?.id ?? null });
    observed.push(selection);
  });
  await f.select();
  const selected = f.player.getSelectionSnapshot();
  expect(selected).toEqual({ scope: "owner:root", trackId: "one" });
  f.media.currentTime = 27;
  f.media.dispatchEvent(new Event("timeupdate"));
  f.player.volume(0.3);
  f.media.pause();
  expect(f.player.getSnapshot()).toMatchObject({ position: 27, volume: 0.3, playing: false });
  expect(f.player.getSelectionSnapshot()).toBe(selected);
  expect(observed.every((x) => x === selected)).toBe(true);
  await f.player.skip(1);
  expect(f.player.getSelectionSnapshot()).toEqual({ scope: "owner:root", trackId: "two" });
  await f.player.skip(-1);
  const back = f.player.getSelectionSnapshot();
  expect(back).toEqual(selected);
  const otherScope = { ...f.client, scope: "share:root" };
  await f.player.select(otherScope, page(), items[0]!);
  expect(f.player.getSelectionSnapshot()).toEqual({ scope: "share:root", trackId: "one" });
  expect(f.player.getSelectionSnapshot()).not.toBe(back);
  f.lifetime.abort();
  expect(f.player.getSelectionSnapshot()).toEqual({ scope: "", trackId: null });
  expect(observed.at(-1)).toBe(f.player.getSelectionSnapshot());
});
it("coalesces saves while a receipt is pending and uses the returned CAS value", async () => {
  const f = fixture();
  await f.select();
  const receipt = deferred<{ positionMs: number; updatedAt: number }>();
  const save = vi
    .fn()
    .mockImplementationOnce(() => receipt.promise)
    .mockResolvedValueOnce({ positionMs: 18000, updatedAt: 22 });
  f.client.save = save;
  f.media.currentTime = 12;
  const first = f.player.flush();
  f.media.currentTime = 15;
  void f.player.flush();
  f.media.currentTime = 18;
  void f.player.flush();
  expect(save).toHaveBeenCalledTimes(1);
  receipt.resolve({ positionMs: 12000, updatedAt: 21 });
  await first;
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]?.slice(2, 4)).toEqual([18000, 21]);
});
it("does not retry a conflicting save and explicitly reloads the newer state", async () => {
  const f = fixture();
  await f.select();
  f.saved.set("one", { positionMs: 60000, updatedAt: 5 });
  f.media.currentTime = 9;
  await f.player.flush();
  expect(f.player.getSnapshot().reload).toBe(true);
  f.media.currentTime = 11;
  await f.player.flush();
  expect(f.client.save).toHaveBeenCalledTimes(1);
  await f.player.reload();
  expect(f.media.currentTime).toBe(60);
  expect(f.player.getSnapshot().reload).toBe(false);
});
it("also requires reload after an unknown write result instead of overwriting it", async () => {
  const f = fixture();
  await f.select();
  f.client.save = vi.fn().mockRejectedValue(new Error("lost_ack"));
  f.media.currentTime = 9;
  await f.player.flush();
  await f.player.flush();
  expect(f.client.save).toHaveBeenCalledTimes(1);
  expect(f.player.getSnapshot().reload).toBe(true);
});
it("renews a playing native URL without reloading it or losing its position", async () => {
  const f = fixture(true);
  await f.select();
  const loads = f.media.loads,
    url = f.media.src;
  f.media.currentTime = 45;
  await vi.advanceTimersByTimeAsync(270000);
  expect(f.client.original).toHaveBeenCalledTimes(2);
  expect(f.media.src).toBe(url);
  expect(f.media.loads).toBe(loads);
  expect(f.media.currentTime).toBe(45);
  expect(f.client.save).toBeUndefined();
  expect(f.client.current).toHaveBeenCalledTimes(19);
});
it("discards buffered media at hard expiry even when renewal never completes", async () => {
  const f = fixture(true);
  await f.select();
  f.client.original = vi.fn(() => new Promise<{ url: string; expiresAt: number }>(() => {}));
  await vi.advanceTimersByTimeAsync(300000);
  expect(f.media.src).toBe("");
  expect(f.media.paused).toBe(true);
  expect(f.player.getSnapshot().track).toBeNull();
});
it("stops buffered public playback on share revocation", async () => {
  const f = fixture(true);
  await f.select();
  f.client.current = vi.fn().mockRejectedValue({ status: 404 });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.media.src).toBe("");
  expect(f.player.getSnapshot().track).toBeNull();
});
it("logout aborts pending original acquisition and delayed completion cannot revive playback", async () => {
  const f = fixture();
  const original = deferred<{ url: string; expiresAt: number }>();
  f.client.original = vi.fn(() => original.promise);
  const selected = f.select();
  await vi.advanceTimersByTimeAsync(0);
  f.lifetime.abort();
  original.resolve({
    url: "https://content.example/c/one/blob-one",
    expiresAt: Date.now() + 300000,
  });
  await selected;
  expect(f.media.src).toBe("");
  expect(f.media.play).not.toHaveBeenCalled();
  expect(f.player.getSnapshot().track).toBeNull();
});
it("a newer selection wins over a delayed earlier current-state response", async () => {
  const f = fixture();
  const current = deferred<AudioPage>();
  vi.mocked(f.client.current).mockImplementationOnce(() => current.promise);
  const first = f.select();
  await vi.advanceTimersByTimeAsync(0);
  await f.player.select(f.client, page(), items[1]!);
  current.resolve(page([items[0]!]));
  await first;
  expect(f.media.src).toContain("/two/blob-two");
  expect(f.player.getSnapshot().track?.id).toBe("two");
});
it("switching back waits for a pending save before reloading the same track", async () => {
  const f = fixture();
  await f.select();
  const receipt = deferred<{ positionMs: number; updatedAt: number }>();
  f.client.save = vi.fn(async () => {
    const result = await receipt.promise;
    f.saved.set("one", result);
    return result;
  });
  f.media.currentTime = 35;
  const next = f.player.skip(1);
  const back = f.player.select(f.client, page(), items[0]!);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.media.src).toBe("");
  receipt.resolve({ positionMs: 35000, updatedAt: 5 });
  await Promise.all([next, back]);
  expect(f.media.currentTime).toBe(35);
});
it("rejects an original replacement instead of applying the old position", async () => {
  const f = fixture();
  f.client.current = vi.fn(async () => page([{ ...items[0]!, currentBlobId: "replacement" }]));
  await f.select();
  expect(f.client.original).not.toHaveBeenCalled();
  expect(f.player.getSnapshot().track).toBeNull();
});
it("decoder refusal keeps a download action available and never starts native playback", async () => {
  const f = fixture();
  f.media.canPlayType.mockReturnValue("");
  await f.select();
  expect(f.media.play).not.toHaveBeenCalled();
  const target = { location: { replace: vi.fn() }, close: vi.fn() };
  await f.player.download(target as unknown as Window);
  expect(target.location.replace).toHaveBeenCalledWith(
    "https://content.example/c/one/blob-one?download=1",
  );
});
it("ended playback records zero and advances without overwriting it with the duration", async () => {
  const f = fixture();
  await f.select();
  f.media.currentTime = 90;
  f.media.ended = true;
  f.media.paused = true;
  f.media.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.saved.get("one")?.positionMs).toBe(0);
  expect(f.player.getSnapshot().track?.id).toBe("two");
});
