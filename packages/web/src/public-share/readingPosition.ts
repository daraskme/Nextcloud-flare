import type { ArchiveBook } from "../../../shared/src/library";
import { type BookClient, validReadingState } from "./bookClient";

export type ReadingStatus = "pending" | "saved" | "conflict" | "failed";

/** Debounce visible pages, serialize CAS updates, and stop after an uncertain result. */
export class ReadingPositionWriter {
  #previous: number | null;
  #stored: number | null;
  #desired: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #task: Promise<void> | undefined;
  #failed = false;
  #closed = false;
  #stop = new AbortController();

  constructor(
    readonly book: ArchiveBook,
    readonly save: NonNullable<BookClient["save"]>,
    readonly lifetime: AbortSignal,
    readonly notify: (status: ReadingStatus) => void,
  ) {
    this.#previous = book.reading?.updatedAt ?? null;
    this.#stored = book.reading?.page ?? null;
  }

  displayed(page: number) {
    if (
      this.#closed ||
      this.#failed ||
      this.lifetime.aborted ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > this.book.pageCount
    )
      return;
    this.#desired = page;
    clearTimeout(this.#timer);
    if (!this.#task && page === this.#stored) {
      this.notify("saved");
      return;
    }
    this.notify("pending");
    this.#timer = setTimeout(() => void this.flush(), 5000);
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer);
    if (this.#task) return this.#task;
    if (this.#failed || this.#stop.signal.aborted || this.lifetime.aborted)
      return Promise.resolve();
    this.#task = this.#drain().finally(() => {
      this.#task = undefined;
    });
    return this.#task;
  }

  async #drain() {
    while (this.#desired !== null && this.#desired !== this.#stored) {
      const page = this.#desired;
      const signal = AbortSignal.any([
        this.#stop.signal,
        this.lifetime,
        AbortSignal.timeout(30000),
      ]);
      try {
        signal.throwIfAborted();
        const result = await this.save(
          {
            blobId: this.book.blobId,
            generator: this.book.generator,
            indexHash: this.book.indexHash,
            page,
            previousUpdatedAt: this.#previous,
          },
          signal,
        );
        signal.throwIfAborted();
        if (
          !validReadingState(result, this.book.pageCount) ||
          result.page !== page ||
          result.updatedAt <= (this.#previous ?? -1)
        )
          throw new Error("invalid_reading_receipt");
        this.#previous = result.updatedAt;
        this.#stored = page;
      } catch (error) {
        this.#failed = true;
        if (!this.#stop.signal.aborted && !this.lifetime.aborted) {
          const status =
            error && typeof error === "object" && "status" in error ? error.status : null;
          this.notify(status === 409 ? "conflict" : "failed");
        }
        return;
      }
    }
    if (!this.#stop.signal.aborted && !this.lifetime.aborted) this.notify("saved");
  }

  finish() {
    this.#closed = true;
    return this.flush();
  }

  get failed() {
    return this.#failed;
  }

  abort() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#stop.abort();
  }
}
