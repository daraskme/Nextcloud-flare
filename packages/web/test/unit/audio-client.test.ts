import { afterEach, expect, it, vi } from "vitest";
import type { AudioPage, AudioTrack } from "../../../shared/src/audio";
import {
  type AudioClient,
  audioCoverRequestState,
  audioOriginal,
  readAudioPage,
} from "../../src/public-share/audioClient";

afterEach(() => vi.unstubAllGlobals());
const item = { id: "node", currentBlobId: "blob" } as AudioTrack;
const signal = () => new AbortController().signal;
it("validates cover receipts against the exact original and fixed generator before updating artwork", () => {
  const receipt = {
    nodeId: item.id,
    blobId: item.currentBlobId,
    variant: "sm",
    generator: "audio-cover-webp-v1",
    state: "ready",
  };
  for (const state of ["pending", "ready", "absent", "failed", "unsupported"])
    expect(audioCoverRequestState({ ...receipt, state }, item)).toBe(state);
  for (const change of [
    { nodeId: "other" },
    { blobId: "old" },
    { variant: "lg" },
    { generator: "image-webp-v1" },
    { state: "done" },
  ])
    expect(() => audioCoverRequestState({ ...receipt, ...change }, item)).toThrow(
      "invalid_cover_receipt",
    );
});
function audioPage(items: AudioTrack[] = [], nextCursor: string | null = null): AudioPage {
  return {
    rootId: "folder",
    treeGeneration: 1,
    generator: "track-metadata-v1",
    items,
    nextCursor,
    limitReached: false,
    trackLimit: 2000,
  };
}
function client(pages: AudioPage[]) {
  const list = vi.fn(async (_cursor: string | null, _signal: AbortSignal) => {
    const next = pages.shift();
    if (!next) throw new Error("unexpected_request");
    return next;
  });
  return { list, client: { scope: "scope", signal: signal(), list } as unknown as AudioClient };
}
it("continues empty windows for at most three requests, then resumes only on the next action", async () => {
  const c = client([
    audioPage([], "one"),
    audioPage([], "two"),
    audioPage([], "three"),
    audioPage([item]),
  ]);
  const first = await readAudioPage(c.client, null, signal());
  expect(first.items).toEqual([]);
  expect(first.nextCursor).toBe("three");
  expect(c.list).toHaveBeenCalledTimes(3);
  const next = await readAudioPage(c.client, first, signal());
  expect(next.items).toEqual([item]);
  expect(next.nextCursor).toBeNull();
  expect(c.list).toHaveBeenCalledTimes(4);
  expect(c.list.mock.calls.map((call) => call[0])).toEqual([null, "one", "two", "three"]);
});
it("stops as soon as a new track or the final empty window is returned", async () => {
  const c = client([audioPage([], "two"), audioPage([item], "three")]);
  const prior = audioPage([{ ...item, id: "prior" }], "one");
  expect((await readAudioPage(c.client, prior, signal())).items.map((x) => x.id)).toEqual([
    "prior",
    "node",
  ]);
  expect(c.list).toHaveBeenCalledTimes(2);
  const empty = client([audioPage()]);
  expect((await readAudioPage(empty.client, null, signal())).nextCursor).toBeNull();
  expect(empty.list).toHaveBeenCalledTimes(1);
});
it.each(["rootId", "treeGeneration", "generator"])(
  "rejects a changed %s between empty windows",
  async (field) => {
    const c = client([
      audioPage([], "one"),
      { ...audioPage([item]), [field]: field === "treeGeneration" ? 2 : "different" },
    ]);
    await expect(readAudioPage(c.client, null, signal())).rejects.toThrow("audio_list_changed");
  },
);
it("does not continue a stalled cursor or revive a cancelled scan", async () => {
  const c = client([audioPage([], "same"), audioPage([], "same")]);
  await expect(readAudioPage(c.client, null, signal())).rejects.toThrow("audio_cursor_stalled");
  expect(c.list).toHaveBeenCalledTimes(2);
  const stop = new AbortController();
  const cancelled = client([audioPage([], "next")]);
  stop.abort();
  await expect(readAudioPage(cancelled.client, null, stop.signal)).rejects.toThrow();
  expect(cancelled.list).toHaveBeenCalledTimes(1);
});
it("exchanges a small credential receipt and returns the fixed original URL without fetching media", async () => {
  const expiresAt = Date.now() + 300000;
  const fetcher = vi.fn(async () => Response.json({ expiresAt }));
  vi.stubGlobal("fetch", fetcher);
  expect(await audioOriginal("https://content.example", "ticket", item, signal())).toEqual({
    url: "https://content.example/c/node/blob",
    expiresAt,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://content.example/session",
    expect.objectContaining({
      method: "POST",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ ticket: "ticket" }),
    }),
  );
});
it("rejects invalid origins, target paths and expired or unbounded receipts", async () => {
  const fetcher = vi.fn(async () => Response.json({ expiresAt: Date.now() - 1 }));
  vi.stubGlobal("fetch", fetcher);
  for (const origin of [
    "http://content.example",
    "https://content.example/path",
    "https://user@content.example",
  ])
    await expect(audioOriginal(origin, "ticket", item, signal())).rejects.toThrow(
      "invalid_audio_target",
    );
  await expect(
    audioOriginal("https://content.example", "ticket", { ...item, id: "../other" }, signal()),
  ).rejects.toThrow("invalid_audio_target");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(audioOriginal("https://content.example", "ticket", item, signal())).rejects.toThrow(
    "invalid_audio_session",
  );
  fetcher.mockImplementation(async () => Response.json({ expiresAt: Date.now() + 700000 }));
  await expect(audioOriginal("https://content.example", "ticket", item, signal())).rejects.toThrow(
    "invalid_audio_session",
  );
});
it("preserves denied status and rejects an aborted exchange even after the response arrives", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));
  await expect(
    audioOriginal("https://content.example", "ticket", item, signal()),
  ).rejects.toMatchObject({ status: 403 });
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => {
    controller.abort();
    return Response.json({ expiresAt: Date.now() + 300000 });
  });
  await expect(
    audioOriginal("https://content.example", "ticket", item, controller.signal),
  ).rejects.toThrow();
});
