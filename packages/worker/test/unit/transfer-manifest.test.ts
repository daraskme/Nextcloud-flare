import { expect, it } from "vitest";
import { digestJson } from "../../src/jobs/operations";
import { transferManifestDigest } from "../../src/services/transferManifestDigest";

it("preserves historical hashes, including the empty overwrite manifest and member order", async () => {
  for (const ids of [[], ["root", "file-a", "file-b"], ["op_123_c0001"]])
    expect(await transferManifestDigest(ids)).toBe(await digestJson(ids));
  expect(await transferManifestDigest(["a", "b"])).not.toBe(
    await transferManifestDigest(["b", "a"]),
  );
});
it("accepts all 1,000 maximum-length IDs while retaining the general intent budget", async () => {
  const ids = Array.from({ length: 1_000 }, (_, i) => String(i).padStart(128, "a"));
  expect(await transferManifestDigest(ids)).toMatch(/^[a-f0-9]{64}$/);
  await expect(digestJson(ids)).rejects.toThrow("intent_too_large");
  await expect(transferManifestDigest([...ids, "overflow"])).rejects.toThrow(
    "invalid_transfer_manifest",
  );
});
it.each([[""], ["x".repeat(129)], ["a/b"], ["日本語"], new Array<string>(1)])(
  "rejects malformed manifest IDs %#",
  async (...ids) => {
    await expect(transferManifestDigest(ids)).rejects.toThrow("invalid_transfer_manifest");
  },
);
