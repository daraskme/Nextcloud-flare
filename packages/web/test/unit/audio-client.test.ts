import { afterEach, expect, it, vi } from "vitest";
import type { AudioTrack } from "../../../shared/src/audio";
import { audioOriginal } from "../../src/public-share/audioClient";

afterEach(() => vi.unstubAllGlobals());
const item = { id: "node", currentBlobId: "blob" } as AudioTrack;
const signal = () => new AbortController().signal;
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
