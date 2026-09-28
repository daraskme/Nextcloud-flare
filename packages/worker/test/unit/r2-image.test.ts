import { expect, it } from "vitest";
import { type R2WriteRequest, validateR2Write } from "../../src/db/r2Write";

function request(): R2WriteRequest {
  const imageId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    epoch: 1,
    ownerId: "owner",
    kind: "image.put",
    key: `u/owner/d/source/image-webp-v1/sm/${imageId}`,
    deadline: Date.now() + 1000,
    image: {
      imageId,
      attemptId: crypto.randomUUID(),
      claimToken: crypto.randomUUID(),
      expiresAt: Date.now() + 5000,
    },
  };
}
it("rejects mixing an image proof with another native write kind", () => {
  const r = request();
  expect(() => validateR2Write(r)).not.toThrow();
  for (const kind of ["upload.put", "copy.put", "blob.delete", "manifest.put"] as const)
    expect(() => validateR2Write({ ...r, kind })).toThrow("invalid_r2_write");
});
it.each(["owner", "generation", "expiry", "missing", "claim", "mixed"])(
  "refuses invalid image dispatch proof: %s",
  (change) => {
    const r = request();
    if (change === "owner") r.ownerId = "different";
    if (change === "generation") r.key = r.key.replace(r.image!.imageId, crypto.randomUUID());
    if (change === "expiry") r.image!.expiresAt = r.deadline - 1;
    if (change === "missing") delete r.image;
    if (change === "claim") r.image!.claimToken = "invalid";
    if (change === "mixed") r.gc = { claimToken: crypto.randomUUID(), mode: true };
    expect(() => validateR2Write(r)).toThrow("invalid_r2_write");
  },
);
