import { afterEach, expect, it, vi } from "vitest";
import type { ArchiveBook } from "../../../shared/src/library";
import { type BookClient, openBook } from "../../src/public-share/bookClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  vi.stubGlobal("location", { origin: "https://app.invalid" });
  const book: ArchiveBook = {
    nodeId: "node",
    spaceId: "space",
    blobId: "blob",
    title: "A book",
    pageCount: 2,
    generator: "archive-index-v1",
  };
  const client: BookClient = {
    contentOrigin: "https://content.invalid",
    nodeId: book.nodeId,
    blobId: book.blobId,
    lifetime: new AbortController().signal,
    book: vi.fn(async () => book),
    ticket: vi.fn(async () => ({ ticket: "signed" })),
  };
  const expiresAt = Date.now() + 300000,
    fetch = vi.fn(async () => Response.json({ expiresAt }, { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  return { client, book, fetch, expiresAt };
}
it("exchanges a purpose-bound ticket without putting credentials into the page URL", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    session = await openBook(f.client, signal);
  expect(session.url).toBe("https://content.invalid/c/node/blob/pages/");
  expect(session.expiresAt).toBe(f.expiresAt);
  expect(f.fetch).toHaveBeenCalledWith(
    "https://content.invalid/session",
    expect.objectContaining({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
      body: '{"ticket":"signed"}',
    }),
  );
});
it.each([
  { blobId: "new" },
  { nodeId: "alias" },
  { nodeId: "../bad" },
  { pageCount: 0 },
  { pageCount: 10001 },
  { generator: "future" },
])("rejects a stale or malformed book: %j", async (change) => {
  const f = fixture();
  Object.assign(f.book, change);
  await expect(openBook(f.client, new AbortController().signal)).rejects.toThrow(
    "book_unavailable",
  );
  expect(f.client.ticket).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["https://app.invalid", "http://content.invalid", "https://content.invalid/path"])(
  "rejects unsupported content origin %s",
  async (contentOrigin) => {
    const f = fixture();
    await expect(
      openBook({ ...f.client, contentOrigin }, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
it.each([0, Date.now() + 700000, "tomorrow", null])(
  "rejects a malformed or expired session: %s",
  async (expiresAt) => {
    const f = fixture();
    f.fetch.mockResolvedValue(Response.json({ expiresAt }));
    await expect(openBook(f.client, new AbortController().signal)).rejects.toThrow(
      "book_unavailable",
    );
  },
);
