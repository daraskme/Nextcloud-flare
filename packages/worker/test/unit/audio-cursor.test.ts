import { base64url } from "jose";
import { expect, it } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";

const claims = {
  parentId: "folder",
  spaceId: "space",
  ownerId: "owner",
  userId: "user",
  credentialId: "as:session",
  epoch: 1,
  generation: 1,
  generator: "track-metadata-v1",
  lastNameCi: "曲.opus",
  lastId: "track",
  emitted: 200,
};
async function setup() {
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  let now = 1800000000000;
  const tokens = new AudioCursorTokens(ring, () => now);
  const signed = async (body: object) => {
    const header = base64url.encode(
      JSON.stringify({ alg: "HS256", kid: "test", typ: "ncf-audio-cursor" }),
    );
    const data = header + "." + base64url.encode(JSON.stringify(body));
    return (
      data +
      "." +
      base64url.encode(
        new Uint8Array(
          await crypto.subtle.sign("HMAC", ring.keys.get("test")!, new TextEncoder().encode(data)),
        ),
      )
    );
  };
  return {
    tokens,
    signed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("expires audio cursors at ten minutes and rejects signature modification", async () => {
  const t = await setup(),
    token = await t.tokens.issue(claims);
  expect(await t.tokens.verify(token)).toMatchObject({ ...claims, aud: "ncf-audio-tracks" });
  await expect(t.tokens.verify(token.slice(0, -5) + "aaaaa")).rejects.toThrow(
    "invalid_audio_cursor",
  );
  t.advance(599000);
  await expect(t.tokens.verify(token)).resolves.toMatchObject(claims);
  t.advance(1000);
  await expect(t.tokens.verify(token)).rejects.toThrow("invalid_audio_cursor");
});
it.each(["audience", "generator", "count", "unknown-field"])(
  "rejects a signed but invalid %s claim",
  async (kind) => {
    const t = await setup();
    const c = { ...(await t.tokens.verify(await t.tokens.issue(claims))) };
    const value =
      kind === "audience"
        ? { ...c, aud: "ncf-node-list" }
        : kind === "generator"
          ? { ...c, generator: "old" }
          : kind === "count"
            ? { ...c, emitted: 2000 }
            : { ...c, unexpected: true };
    await expect(t.tokens.verify(await t.signed(value))).rejects.toThrow("invalid_audio_cursor");
  },
);
