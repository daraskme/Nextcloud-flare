import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { digestSha256, putKnownLength } from "../../src/services/streaming.js";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const midpoint = Math.floor(bytes.byteLength / 2);
      controller.enqueue(bytes.slice(0, midpoint));
      controller.enqueue(bytes.slice(midpoint));
      controller.close();
    },
  });
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("R2 stream spike", () => {
  it("stores one known-length stream and serves a single range", async () => {
    const bytes = new TextEncoder().encode("0123456789");
    const object = await putKnownLength(
      env.BLOBS,
      "spike/known-length",
      streamOf(bytes),
      bytes.length,
    );
    expect(object.size).toBe(bytes.length);

    const ranged = await env.BLOBS.get("spike/known-length", {
      range: { offset: 2, length: 4 },
    });
    expect(ranged).not.toBeNull();
    await expect(ranged?.arrayBuffer()).resolves.toEqual(new TextEncoder().encode("2345").buffer);
  });

  it("rejects a mismatched fixed-length stream", async () => {
    const bytes = new TextEncoder().encode("short");
    const fixed = new FixedLengthStream(bytes.length + 1);
    const outcomes = await Promise.allSettled([
      streamOf(bytes).pipeTo(fixed.writable),
      new Response(fixed.readable).arrayBuffer(),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("computes SHA-256 with DigestStream", async () => {
    const digest = await digestSha256(streamOf(new TextEncoder().encode("abc")));
    expect(toHex(digest)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
