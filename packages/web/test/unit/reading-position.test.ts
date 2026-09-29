import { afterEach, expect, it, vi } from "vitest";
import type { ArchiveBook, PageReadingState } from "../../../shared/src/library";
import type { BookClient } from "../../src/public-share/bookClient";
import { ReadingPositionWriter } from "../../src/public-share/readingPosition";

afterEach(() => {
  vi.useRealTimers();
});
function fixture(reading: PageReadingState | null = null) {
  vi.useFakeTimers();
  const book: ArchiveBook = {
    nodeId: "node",
    spaceId: "space",
    blobId: "blob",
    title: "Book",
    pageCount: 20,
    generator: "archive-index-v1",
    indexHash: "a".repeat(64),
    reading,
  };
  let timestamp = reading?.updatedAt ?? 0;
  const save = vi.fn<NonNullable<BookClient["save"]>>(async (update) => ({
    page: update.page,
    updatedAt: ++timestamp,
  }));
  const lifetime = new AbortController(),
    notify = vi.fn();
  const writer = new ReadingPositionWriter(book, save, lifetime.signal, notify);
  return { book, save, lifetime, notify, writer };
}
it("coalesces rapid pages for five seconds and retains the current generation", async () => {
  const f = fixture();
  f.writer.displayed(1);
  await vi.advanceTimersByTimeAsync(4000);
  f.writer.displayed(2);
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.save).toHaveBeenCalledExactlyOnceWith(
    {
      blobId: "blob",
      generator: "archive-index-v1",
      indexHash: f.book.indexHash,
      page: 2,
      previousUpdatedAt: null,
    },
    expect.any(AbortSignal),
  );
  expect(f.notify).toHaveBeenLastCalledWith("saved");
  f.writer.displayed(2);
  await f.writer.finish();
  expect(f.save).toHaveBeenCalledTimes(1);
});
it("serializes in-flight updates and saves only the latest queued page with the new CAS", async () => {
  const f = fixture({ page: 1, updatedAt: 100 });
  let settle!: (state: PageReadingState) => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  f.save.mockResolvedValueOnce({ page: 5, updatedAt: 102 });
  f.writer.displayed(2);
  const pending = f.writer.flush();
  f.writer.displayed(3);
  f.writer.displayed(5);
  expect(f.save).toHaveBeenCalledTimes(1);
  const finished = f.writer.finish();
  f.writer.displayed(7);
  settle({ page: 2, updatedAt: 101 });
  await Promise.all([pending, finished]);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1]![0]).toMatchObject({ page: 5, previousUpdatedAt: 101 });
  expect(f.notify).toHaveBeenLastCalledWith("saved");
});
it.each([409, 503])(
  "stops after status %s without silently overwriting or retrying",
  async (status) => {
    const f = fixture();
    f.save.mockRejectedValue(Object.assign(new Error("failed"), { status }));
    f.writer.displayed(2);
    await f.writer.flush();
    f.writer.displayed(3);
    await vi.advanceTimersByTimeAsync(6000);
    await f.writer.finish();
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.writer.failed).toBe(true);
    expect(f.notify).toHaveBeenLastCalledWith(status === 409 ? "conflict" : "failed");
  },
);
it("does not write after account lifetime revocation or unmount", async () => {
  const f = fixture();
  f.writer.displayed(2);
  f.lifetime.abort();
  await f.writer.finish();
  expect(f.save).not.toHaveBeenCalled();
  const g = fixture();
  g.writer.displayed(2);
  g.writer.abort();
  await vi.advanceTimersByTimeAsync(6000);
  await g.writer.finish();
  expect(g.save).not.toHaveBeenCalled();
});
it("rejects stale or mismatched receipts before sending another page", async () => {
  const f = fixture({ page: 1, updatedAt: 100 });
  f.save.mockResolvedValue({ page: 2, updatedAt: 100 });
  f.writer.displayed(2);
  await f.writer.flush();
  f.writer.displayed(3);
  await f.writer.finish();
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.notify).toHaveBeenLastCalledWith("failed");
});
it("flushes the last displayed page on close without waiting for the debounce", async () => {
  const f = fixture({ page: 2, updatedAt: 100 });
  f.writer.displayed(2);
  expect(f.save).not.toHaveBeenCalled();
  f.writer.displayed(5);
  await f.writer.finish();
  expect(f.save.mock.calls[0]![0]).toMatchObject({ page: 5, previousUpdatedAt: 100 });
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.save).toHaveBeenCalledTimes(1);
});
