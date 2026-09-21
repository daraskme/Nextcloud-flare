import { describe, expect, it } from "vitest";

import { derivePbkdf2, toHex } from "../../src/services/kdf.js";

describe("PBKDF2 spike", () => {
  it("accepts the fixed 100,000 iteration profile", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    const result = await derivePbkdf2("phase-zero-password", salt);
    expect(result.byteLength).toBe(32);
    expect(toHex(result)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects unapproved cost and salt profiles", async () => {
    await expect(derivePbkdf2("password", new Uint8Array(15))).rejects.toThrow();
    await expect(derivePbkdf2("password", new Uint8Array(16), 99_999)).rejects.toThrow();
  });
});
