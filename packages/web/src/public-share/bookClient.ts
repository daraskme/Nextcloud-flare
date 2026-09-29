import type { ArchiveBook, PageReadingState, PageReadingUpdate } from "../../../shared/src/library";

export interface BookClient {
  readonly contentOrigin: string;
  readonly blobId: string;
  readonly nodeId: string;
  readonly lifetime: AbortSignal;
  book(signal: AbortSignal): Promise<ArchiveBook>;
  ticket(signal: AbortSignal): Promise<{ ticket: string }>;
  save?(update: PageReadingUpdate, signal: AbortSignal): Promise<PageReadingState>;
}
export function validReadingState(value: unknown, pageCount: number): value is PageReadingState {
  if (!value || typeof value !== "object") return false;
  const state = value as PageReadingState;
  return (
    Number.isSafeInteger(state.page) &&
    state.page >= 1 &&
    state.page <= pageCount &&
    Number.isSafeInteger(state.updatedAt) &&
    state.updatedAt >= 0 &&
    state.updatedAt < Number.MAX_SAFE_INTEGER
  );
}
export async function openBook(client: BookClient, signal: AbortSignal) {
  const book = await client.book(signal),
    origin = new URL(client.contentOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== client.contentOrigin ||
    origin.origin === location.origin ||
    ![book.nodeId, book.spaceId, book.blobId].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    book.blobId !== client.blobId ||
    book.nodeId !== client.nodeId ||
    book.generator !== "archive-index-v1" ||
    typeof book.indexHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(book.indexHash) ||
    !Number.isSafeInteger(book.pageCount) ||
    book.pageCount < 1 ||
    book.pageCount > 10000 ||
    typeof book.title !== "string" ||
    book.title.length > 4096 ||
    (book.reading !== null && !validReadingState(book.reading, book.pageCount))
  )
    throw new Error("book_unavailable");
  const { ticket } = await client.ticket(signal);
  signal.throwIfAborted();
  const response = await fetch(`${origin.origin}/session`, {
    method: "POST",
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  if (!response.ok) throw Object.assign(new Error("book_unavailable"), { status: response.status });
  const receipt = (await response.json()) as { expiresAt: unknown };
  signal.throwIfAborted();
  if (
    typeof receipt.expiresAt !== "number" ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.expiresAt <= Date.now() ||
    receipt.expiresAt > Date.now() + 600000
  )
    throw new Error("book_unavailable");
  return {
    book,
    expiresAt: receipt.expiresAt,
    url: `${origin.origin}/c/${book.nodeId}/${book.blobId}/pages/`,
  };
}
