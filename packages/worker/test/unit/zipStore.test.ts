import { describe, expect, it } from "vitest";

import { measureStoreZip, serializeStoreZip } from "../../src/services/zipStore.js";

describe("STORE ZIP serializer", () => {
  const entries = [
    { name: "alpha.txt", bytes: new TextEncoder().encode("alpha") },
    { name: "nested/beta.bin", bytes: Uint8Array.of(0, 1, 2, 3) },
  ] as const;

  it("uses the same serializer for dry-run size and emitted bytes", () => {
    const measured = measureStoreZip(entries);
    const output = serializeStoreZip(entries);
    expect(output.size).toBe(measured);
    expect(output.bytes.byteLength).toBe(measured);
  });

  it("emits ZIP local and end-of-central-directory records", () => {
    const { bytes } = serializeStoreZip(entries);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Array.from(bytes.slice(-22, -18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });
});
