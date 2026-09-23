import { base64url } from "jose";
import { expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";

const oldKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const newKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const identity = {
  id: "up_test",
  credential_id: "as:session_test",
  epoch: 1,
  expires_at: 2000000000000,
  capability_kid: "old",
};

it("reissues the same capability after response loss and preserves it across key rotation", async () => {
  const before = new UploadCapabilities(await contentKeyRing("old", { old: oldKey }));
  const after = new UploadCapabilities(await contentKeyRing("new", { old: oldKey, new: newKey }));
  const token = await before.issue(identity);
  expect(await after.issue(identity)).toBe(token);
  await after.verify(identity, token);
  const retired = new UploadCapabilities(await contentKeyRing("new", { new: newKey }));
  await expect(retired.verify(identity, token)).rejects.toThrow("invalid_upload_capability");
  await expect(retired.issue(identity)).rejects.toThrow("upload_capability_key_unavailable");
});

it.each([
  { id: "up_other" },
  { credential_id: "as:other" },
  { epoch: 2 },
  { expires_at: identity.expires_at + 1 },
  { capability_kid: "new" },
])("rejects a capability reused with a changed identity: %j", async (change) => {
  const capabilities = new UploadCapabilities(
    await contentKeyRing("old", { old: oldKey, new: newKey }),
  );
  const token = await capabilities.issue(identity);
  await expect(capabilities.verify({ ...identity, ...change }, token)).rejects.toThrow(
    "invalid_upload_capability",
  );
});

it("rejects signature tampering, invalid encoding, extra segments, and another key", async () => {
  const capabilities = new UploadCapabilities(await contentKeyRing("old", { old: oldKey }));
  const token = await capabilities.issue(identity);
  const changed = new UploadCapabilities(await contentKeyRing("old", { old: newKey }));
  const tokens = ["", `${token}=`, `${token}.extra`, token.replace("old.", "unknown.")];
  for (const value of tokens)
    await expect(capabilities.verify(identity, value)).rejects.toThrow("invalid_upload_capability");
  await expect(changed.verify(identity, token)).rejects.toThrow("invalid_upload_capability");
});
