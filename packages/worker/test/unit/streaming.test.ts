import { describe, expect, it } from "vitest";

import { pumpWithBackpressure } from "../../src/services/streaming.js";

describe("bounded stream pump", () => {
  it("waits for a slow consumer", async () => {
    let produced = 0;
    let written = 0;
    let maximumLead = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 8) {
          controller.close();
          return;
        }
        produced += 1;
        maximumLead = Math.max(maximumLead, produced - written);
        controller.enqueue(Uint8Array.of(produced));
      },
    });
    const sink = new WritableStream<Uint8Array>({
      async write() {
        await new Promise((resolve) => setTimeout(resolve, 2));
        written += 1;
      },
    });

    await pumpWithBackpressure(source, sink);
    expect(written).toBe(8);
    expect(maximumLead).toBeLessThanOrEqual(2);
  });

  it("propagates cancellation to both stream endpoints", async () => {
    let cancelled = false;
    let aborted = false;
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const sink = new WritableStream<Uint8Array>({
      write() {
        controller.abort();
      },
      abort() {
        aborted = true;
      },
    });

    await expect(pumpWithBackpressure(source, sink, controller.signal)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
  });
});
