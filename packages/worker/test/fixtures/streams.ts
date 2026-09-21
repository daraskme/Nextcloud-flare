import { LIMITS } from "@next-cloud-flare/shared/limits";

export function bytesSource(size: number, value = 97, onCancel?: () => void) {
  let produced = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced === size) {
          controller.close();
          return;
        }
        const length = Math.min(size - produced, LIMITS.streamChunkBytes);
        produced += length;
        controller.enqueue(new Uint8Array(length).fill(value));
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, produced: () => produced };
}

export async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
