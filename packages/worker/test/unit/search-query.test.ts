import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { SearchCursorTokens } from "../../src/auth/searchCursor";
import { searchQuery } from "../../src/search/query";

it.each(["ｶﾀｶﾅＡＢＣ", "Straße", "ヷ", "😀かな", "éé"])(
  "normalizes %s exactly like persisted names",
  (input) => {
    expect(searchQuery(input).text).toBe(searchName(input).textNorm);
  },
);

it("treats query operators, wildcards and reserved filenames as literal text", () => {
  expect(searchQuery("  CON  ").text).toBe("con");
  const q = searchQuery('" OR abc%_\\');
  expect(q.pattern).toBe('%" or abc\\%\\_\\\\%');
  expect(q.match).toBe('"or" AND "ab" AND "bc"');
});

it.each(["本", "++", "😀😁", "éé", "%_"])("uses bounded substring fallback for %s", (input) => {
  expect(searchQuery(input).match).toBe("");
});

it("enforces raw, normalized and escaped fallback byte bounds", () => {
  expect(searchQuery("a".repeat(256)).match).toBe('"aa"');
  expect(searchQuery("+".repeat(48)).pattern.length).toBe(50);
  for (const bad of [
    "",
    " ",
    "a\u0000b",
    "\ud800",
    "a".repeat(257),
    "ß".repeat(129),
    "+".repeat(49),
    "%".repeat(25),
  ])
    expect(() => searchQuery(bad)).toThrow("invalid_search_query");
});

it("separates search cursors from listing cursors and binds exact claims and expiry", async () => {
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const now = 1_000_000;
  const cursor = new SearchCursorTokens(ring, () => now);
  const claims = {
    scopeId: "scope",
    spaceId: "space",
    ownerId: "owner",
    userId: "user",
    credentialId: "credential",
    epoch: 1,
    generation: 1,
    lastNameCi: "foo",
    lastId: "last",
    query: "foo",
    version: searchQuery("foo").version,
  };
  const token = await cursor.issue(claims);
  expect(await cursor.verify(token)).toMatchObject(claims);
  await expect(new NodeCursorTokens(ring, () => now).verify(token)).rejects.toThrow();
  await expect(new SearchCursorTokens(ring, () => now + 600_000).verify(token)).rejects.toThrow();
  await expect(cursor.verify(`${token.slice(0, -3)}xxx`)).rejects.toThrow();
  await expect(cursor.issue({ ...claims, version: "old" })).rejects.toThrow();
});
