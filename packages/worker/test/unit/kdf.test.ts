import { afterEach, expect, it, vi } from "vitest";
import {
  KDF_QUEUE_LIMIT,
  KDF_QUEUE_WAIT_MS,
  KdfExecutor,
  KdfUnavailableError,
} from "../../src/auth/kdf";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it("serializes FIFO callers without allowing a new arrival to overtake a granted waiter", async () => {
  const gate = new KdfExecutor(),
    held = deferred(),
    entered = deferred();
  const order: number[] = [];
  const first = gate.run(async () => {
    order.push(1);
    entered.resolve();
    await held.promise;
    return 1;
  });
  await entered.promise;
  const second = gate.run(async () => {
    order.push(2);
    return 2;
  });
  held.resolve();
  const third = gate.run(async () => {
    order.push(3);
    return 3;
  });
  expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
  expect(order).toEqual([1, 2, 3]);
});

it("releases capacity after synchronous and asynchronous exceptions", async () => {
  const gate = new KdfExecutor();
  await expect(
    gate.run(() => {
      throw new Error("sync");
    }),
  ).rejects.toThrow("sync");
  await expect(
    gate.run(async () => {
      throw new Error("async");
    }),
  ).rejects.toThrow("async");
  expect(await gate.run(async () => "recovered")).toBe("recovered");
});

it("bounds waiting work at 256 and immediately recovers cancelled queue capacity", async () => {
  const gate = new KdfExecutor(),
    held = deferred(),
    entered = deferred();
  const first = gate.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const abort = new AbortController(),
    action = vi.fn(async () => undefined);
  const queued = Array.from({ length: KDF_QUEUE_LIMIT }, () => gate.run(action, abort.signal));
  const results = Promise.allSettled(queued);
  try {
    await expect(gate.run(action)).rejects.toBeInstanceOf(KdfUnavailableError);
    abort.abort();
    expect(
      (await results).every(
        (r) => r.status === "rejected" && r.reason instanceof KdfUnavailableError,
      ),
    ).toBe(true);
    expect(action).not.toHaveBeenCalled();
    const next = gate.run(action);
    held.resolve();
    await next;
    expect(action).toHaveBeenCalledTimes(1);
  } finally {
    abort.abort();
    held.resolve();
    await first;
    await results;
  }
});

it.each(["before_acquire", "after_acquire"])("does not start cancelled work (%s)", async (when) => {
  const gate = new KdfExecutor(),
    abort = new AbortController(),
    action = vi.fn(async () => 1);
  if (when === "before_acquire") abort.abort();
  const result = gate.run(action, abort.signal);
  if (when === "after_acquire") abort.abort();
  await expect(result).rejects.toBeInstanceOf(KdfUnavailableError);
  expect(action).not.toHaveBeenCalled();
  expect(await gate.run(async () => 2)).toBe(2);
});

it("keeps an aborted active calculation in its slot until the underlying work settles", async () => {
  const gate = new KdfExecutor(),
    abort = new AbortController(),
    held = deferred(),
    entered = deferred();
  const first = gate.run(async () => {
    entered.resolve();
    await held.promise;
    return "discarded";
  }, abort.signal);
  const rejection = expect(first).rejects.toBeInstanceOf(KdfUnavailableError);
  await entered.promise;
  abort.abort();
  const secondAction = vi.fn(async () => "next"),
    second = gate.run(secondAction);
  await Promise.resolve();
  expect(secondAction).not.toHaveBeenCalled();
  held.resolve();
  await rejection;
  expect(await second).toBe("next");
});

it("times out queued work without freeing the active calculation's slot", async () => {
  vi.useFakeTimers();
  const gate = new KdfExecutor(),
    held = deferred(),
    entered = deferred();
  const first = gate.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const action = vi.fn(async () => 1),
    queued = gate.run(action);
  const rejection = expect(queued).rejects.toBeInstanceOf(KdfUnavailableError);
  await vi.advanceTimersByTimeAsync(KDF_QUEUE_WAIT_MS);
  await rejection;
  expect(action).not.toHaveBeenCalled();
  const next = gate.run(action);
  expect(action).not.toHaveBeenCalled();
  held.resolve();
  await first;
  await next;
  expect(action).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an expired waiter even when its timeout callback has not fired", async () => {
  vi.useFakeTimers();
  const gate = new KdfExecutor(),
    held = deferred(),
    entered = deferred();
  const first = gate.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const action = vi.fn(async () => 1),
    queued = gate.run(action);
  const rejection = expect(queued).rejects.toBeInstanceOf(KdfUnavailableError);
  vi.setSystemTime(Date.now() + KDF_QUEUE_WAIT_MS);
  held.resolve();
  await first;
  await rejection;
  expect(action).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(await gate.run(action)).toBe(1);
});
