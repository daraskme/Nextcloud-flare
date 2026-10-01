import { afterEach, expect, it, vi } from "vitest";
import { debouncedWriter } from "../../src/lib/mediaResume";

afterEach(() => {
  vi.useRealTimers();
});

it("debounces resume writes for five seconds and keeps only the latest position", async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => undefined);
  const writer = debouncedWriter(write);
  writer.schedule(1_000);
  await vi.advanceTimersByTimeAsync(4_000);
  writer.schedule(2_000);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith(2_000);
});

it("flushes terminal resume state immediately and clears stale pending state", async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => undefined);
  const writer = debouncedWriter(write);
  writer.schedule({ spineIndex: 1, progress: 100 });
  await writer.flush({ spineIndex: 2, progress: 0 });
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith({ spineIndex: 2, progress: 0 });
});

it("cancels pending state when the selected blob changes", async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => undefined);
  const writer = debouncedWriter(write);
  writer.schedule(1_000);
  writer.clear();
  await vi.runAllTimersAsync();
  expect(write).not.toHaveBeenCalled();
});
