export interface DebouncedWriter<T> {
  schedule(value: T): void;
  flush(value?: T): Promise<void>;
  clear(): void;
}

export function debouncedWriter<T>(
  write: (value: T) => Promise<unknown>,
  delay = 5_000,
): DebouncedWriter<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: T | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const flush = async (value?: T) => {
    clearTimer();
    const selected = value ?? pending;
    pending = undefined;
    if (selected !== undefined) await write(selected);
  };

  return {
    schedule(value) {
      pending = value;
      clearTimer();
      timer = setTimeout(() => void flush().catch(() => undefined), delay);
    },
    flush,
    clear() {
      clearTimer();
      pending = undefined;
    },
  };
}
