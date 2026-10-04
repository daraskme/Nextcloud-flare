/** Local execution capacity only. Global rate/parallel admission is a separate control. */
export const KDF_QUEUE_LIMIT = 256;
export const KDF_QUEUE_WAIT_MS = 5_000;

export class KdfUnavailableError extends Error {
  constructor() {
    super("kdf_unavailable");
  }
}

interface Waiter {
  deadline: number;
  signal: AbortSignal | undefined;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  resolve: () => void;
  reject: (error: KdfUnavailableError) => void;
}

/** Wake the caller's continuation, never execute another request's I/O in a release callback. */
export class KdfExecutor {
  #active = false;
  readonly #waiting: Waiter[] = [];

  constructor(private readonly maxWaiting = KDF_QUEUE_LIMIT) {
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0 || maxWaiting > KDF_QUEUE_LIMIT)
      throw new Error("invalid_kdf_queue_limit");
  }

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      if (signal?.aborted) throw new KdfUnavailableError();
      const result = await action();
      // An active crypto call cannot be aborted. Retain its slot until it really settles.
      if (signal?.aborted) throw new KdfUnavailableError();
      return result;
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KdfUnavailableError());
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.maxWaiting) return Promise.reject(new KdfUnavailableError());
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index < 0) return;
        this.#waiting.splice(index, 1);
        this.#cleanup(waiter);
        reject(new KdfUnavailableError());
      };
      const waiter: Waiter = {
        deadline: Date.now() + KDF_QUEUE_WAIT_MS,
        signal,
        timer: setTimeout(abort, KDF_QUEUE_WAIT_MS),
        abort,
        resolve,
        reject,
      };
      this.#waiting.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #cleanup(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort);
  }

  #release(): void {
    for (;;) {
      const waiter = this.#waiting.shift();
      if (!waiter) {
        this.#active = false;
        return;
      }
      this.#cleanup(waiter);
      if (waiter.signal?.aborted || waiter.deadline <= Date.now()) {
        waiter.reject(new KdfUnavailableError());
        continue;
      }
      waiter.resolve();
      return; // Ownership transfers without exposing a free slot to a newer request.
    }
  }
}

// Request contexts must not wait on a promise owned by another fetch event.
// A busy KDF is retryable; the active native call retains the slot until it settles.
const executor = new KdfExecutor(0);
export const runKdf = <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  executor.run(action, signal);
