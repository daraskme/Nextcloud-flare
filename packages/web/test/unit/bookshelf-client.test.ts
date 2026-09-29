import { afterEach, expect, it, vi } from "vitest";
import type { LibraryItem } from "../../../shared/src/library";
import { type Account, ApiClient } from "../../src/lib/api";
import { PublicClient, type SharedRoot } from "../../src/public-share/client";

afterEach(() => vi.unstubAllGlobals());
const account = {
  id: "owner",
  epoch: 1,
  spaceId: "space",
  contentOrigin: "https://content.invalid",
} as Account;
const item = { id: "book", currentBlobId: "blob" } as LibraryItem;
it("binds private paging to the selected share and prevents stale actions after account changes", async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient(),
    client = api.bookshelfClient(account, "folder", {
      id: "share",
      version: 3,
      spaceId: "foreign",
    });
  await client.list("a+/=", new AbortController().signal);
  const call = vi.mocked(fetch).mock.calls[0]!,
    url = new URL(String(call[0]), "https://app.invalid");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    scopeRoot: "folder",
    cursor: "a+/=",
    shareId: "share",
    shareVersion: "3",
  });
  const signal = (call[1] as RequestInit).signal!;
  api.clear();
  expect(signal.aborted).toBe(true);
  expect(() => client.book(item)).toThrow();
  await expect(client.original(item, {} as Window)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not register a folder after logout while waiting for CSRF", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient(),
    pending = api.libraryRoot("folder", true),
    rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  api.clear();
  finish(Response.json({ token: "old" }));
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses the exact public unlock session and exposes no reading-state writer", async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  const api = new PublicClient("share", null),
    root = { sessionId: "session", contentOrigin: "https://content.invalid" } as SharedRoot;
  const client = api.bookshelfClient(root, "folder");
  await client.list("cursor", new AbortController().signal);
  expect(vi.mocked(fetch).mock.calls[0]).toEqual([
    "/api/v1/public/shares/share/library?nodeId=folder&cursor=cursor",
    expect.objectContaining({
      headers: expect.objectContaining({ "Share-Session": "session" }),
      cache: "no-store",
      credentials: "same-origin",
    }),
  ]);
  expect(client.book(item).save).toBeUndefined();
  api.close();
  expect(() => client.book(item)).toThrow();
  await expect(client.original(item, {} as Window)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
