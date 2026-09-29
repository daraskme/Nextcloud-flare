import { afterEach, expect, it, vi } from "vitest";
import { type Account, ApiClient } from "../../src/lib/api";
import { galleryOriginal, readGalleryThumbnail } from "../../src/public-share/galleryMedia";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const path = "/api/v1/nodes/node/thumb?variant=sm";
it("materializes only the declared WebP bytes and includes the selected session", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/webp", "Content-Length": "3" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const blob = await readGalleryThumbnail(path, { "Content-Session": "session" }, signal());
  expect(blob.type).toBe("image/webp");
  expect(blob.size).toBe(3);
  expect(fetcher).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      headers: { "Content-Session": "session" },
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    }),
  );
});
it("accepts chunked WebP without Content-Length while bounding the actual bytes", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } }),
  );
  expect((await readGalleryThumbnail(path, {}, signal())).size).toBe(3);
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(12582913));
          },
          cancel,
        }),
        { headers: { "Content-Type": "image/webp" } },
      ),
  );
  await expect(readGalleryThumbnail(path, {}, signal())).rejects.toThrow("thumbnail_size_mismatch");
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(["mime", "large", "long", "short"])(
  "rejects %s thumbnail responses and cancels the input",
  async (kind) => {
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(kind === "long" ? 4 : 2));
        } else if (kind === "short") controller.close();
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body, {
          headers: {
            "Content-Type": kind === "mime" ? "text/html" : "image/webp",
            "Content-Length": kind === "large" ? "12582913" : "3",
          },
        }),
    );
    await expect(readGalleryThumbnail(path, {}, signal())).rejects.toThrow();
    if (kind !== "short") expect(cancel).toHaveBeenCalledOnce();
  },
);
it("does not expose a late original URL after cancellation and never fetches original bytes as a blob", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      controller.abort();
      return Response.json({ sessionId: "session" }, { status: 201 });
    }),
  );
  await expect(
    galleryOriginal(
      "https://content.invalid",
      "ticket",
      { id: "node", currentBlobId: "blob" },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "https://content.invalid/session",
    expect.objectContaining({ method: "POST", credentials: "include" }),
  );
});
it("keeps an internal selection in gallery pages and denies transport reuse after logout", async () => {
  const account: Account = {
    id: "u",
    email: "a@example.invalid",
    role: "user",
    spaceId: "s",
    rootNodeId: "r",
    epoch: 1,
    quotaBytes: 0,
    usedBytes: 0,
    reservedBytes: 0,
    contentOrigin: "https://content.invalid",
  };
  const api = new ApiClient(),
    client = api.galleryClient(account, "folder", { id: "share", version: 3, spaceId: "other" });
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return Response.json({ items: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  await client.list(true, "cursor", signal());
  expect(fetcher.mock.calls[0]![0]).toBe(
    "/api/v1/nodes/folder/gallery?recursive=1&cursor=cursor&shareId=share&shareVersion=3",
  );
  api.clear();
  await expect(client.list(false, null, signal())).rejects.toThrow();
});
