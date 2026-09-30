import { base64url } from "jose";
import { expect, it } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";

const now = 1_800_000_000_000;

async function ring() {
  return contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
}

it("signs gallery cursors with authority, generation, mode, and position claims", async () => {
  const tokens = new GalleryCursorTokens(await ring(), () => now);
  const cursor = await tokens.issue({
    rootId: "root",
    spaceId: "space",
    ownerId: "owner",
    userId: "user",
    credentialId: "as:session",
    epoch: 4,
    generation: 7,
    recursive: true,
    lastSort: 123,
    lastId: "node",
  });
  await expect(tokens.verify(cursor)).resolves.toMatchObject({
    aud: "ncf-gallery",
    rootId: "root",
    credentialId: "as:session",
    epoch: 4,
    generation: 7,
    recursive: true,
    lastSort: 123,
    lastId: "node",
  });
  await expect(
    tokens.verify(`${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`),
  ).rejects.toThrow("invalid_gallery_cursor");
  await expect(
    new GalleryCursorTokens(tokens.ring, () => now + 601_000).verify(cursor),
  ).rejects.toThrow("invalid_gallery_cursor");
});

it("signs bounded audio cursors and rejects an exhausted emitted count", async () => {
  const tokens = new AudioCursorTokens(await ring(), () => now);
  const claims = {
    rootId: "root",
    spaceId: "space",
    ownerId: "owner",
    userId: "user",
    credentialId: "as:session",
    epoch: 4,
    generation: 7,
    recursive: true,
    lastNameCi: "track",
    lastId: "node",
  };
  const cursor = await tokens.issue({ ...claims, emitted: 200 });
  await expect(tokens.verify(cursor)).resolves.toMatchObject({
    aud: "ncf-audio",
    ...claims,
    emitted: 200,
  });
  await expect(tokens.issue({ ...claims, emitted: 2_000 })).rejects.toThrow("invalid_audio_cursor");
});
