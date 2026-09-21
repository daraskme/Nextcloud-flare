import { expect, it } from "vitest";
import { accessFingerprint } from "../../src/auth/sessions";
import { epochNumber, parseEpochFloor, recoverEpochFloor } from "../../src/do/epochHistory";

it.each(["0", "-1", "1.0", "1e3", "", " 10 ", "9007199254740992"])(
  "rejects invalid operator epoch floor %s",
  (value) => {
    expect(() => parseEpochFloor(value)).toThrow();
  },
);
it("never falls back to a timestamp or reuses an exhausted epoch", () => {
  expect(parseEpochFloor(undefined)).toBeUndefined();
  expect(parseEpochFloor("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => epochNumber(Number.MAX_SAFE_INTEGER + 1)).toThrow();
});
it("paginates the whole epoch history before issuing a value", async () => {
  const cursors: (string | undefined)[] = [];
  const bucket = {
    list: async (options: R2ListOptions) => {
      cursors.push(options.cursor);
      return options.cursor
        ? { objects: [{ key: "sys/epoch/1000.json" }], truncated: false }
        : { objects: [{ key: "sys/epoch/9.json" }], truncated: true, cursor: "page2" };
    },
  } as unknown as R2Bucket;
  expect(await recoverEpochFloor(bucket, 1)).toBe(1001);
  expect(cursors).toEqual([undefined, "page2"]);
});
it("rejects malformed history and a non-advancing cursor", async () => {
  for (const result of [
    { objects: [{ key: "sys/epoch/broken.json" }], truncated: false },
    { objects: [], truncated: true, cursor: "same" },
  ]) {
    const bucket = { list: async () => result } as unknown as R2Bucket;
    await expect(recoverEpochFloor(bucket, 1)).rejects.toThrow();
  }
});
it("binds the access fingerprint to all four identity fields", async () => {
  const claims = { iss: "https://issuer.invalid", sub: "one", iat: 1, exp: 101 };
  const fingerprint = await accessFingerprint(claims);
  for (const change of [
    { iss: "https://other.invalid" },
    { sub: "two" },
    { iat: 2 },
    { exp: 102 },
  ]) {
    expect(await accessFingerprint({ ...claims, ...change })).not.toBe(fingerprint);
  }
  await expect(accessFingerprint({ ...claims, sub: "ambiguous|value" })).rejects.toThrow();
  await expect(accessFingerprint({ ...claims, exp: 86402 })).rejects.toThrow();
});
