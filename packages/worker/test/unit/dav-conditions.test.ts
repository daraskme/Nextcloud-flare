import { expect, it } from "vitest";
import { evaluateDavIf, parseDavIfHeader, parseDavLockTokenHeader } from "../../src/dav/conditions";

it("parses untagged If lists as OR branches with AND conditions", () => {
  expect(
    parseDavIfHeader('(<opaquelocktoken:first> ["etag-1"]) (Not <DAV:no-lock> [W/"weak-2"])'),
  ).toEqual({
    form: "untagged",
    lists: [
      {
        resourceTag: null,
        conditions: [
          { kind: "token", value: "opaquelocktoken:first", not: false },
          { kind: "etag", value: '"etag-1"', weak: false, not: false },
        ],
      },
      {
        resourceTag: null,
        conditions: [
          { kind: "token", value: "DAV:no-lock", not: true },
          { kind: "etag", value: '"weak-2"', weak: true, not: false },
        ],
      },
    ],
    submittedTokens: ["DAV:no-lock", "opaquelocktoken:first"],
  });
});

it("parses tagged resources and collects tokens independently of branch truth", () => {
  const parsed = parseDavIfHeader(
    '<https://app.invalid/dav/a> (<opaquelocktoken:a>) (Not <opaquelocktoken:false>) <https://app.invalid/dav/b> (["b"])',
  );
  expect(parsed?.form).toBe("tagged");
  expect(parsed?.lists.map((list) => list.resourceTag)).toEqual([
    "https://app.invalid/dav/a",
    "https://app.invalid/dav/a",
    "https://app.invalid/dav/b",
  ]);
  expect(parsed?.submittedTokens).toEqual(["opaquelocktoken:a", "opaquelocktoken:false"]);
});

it("rejects malformed and ambiguous If headers", () => {
  for (const value of [
    "",
    "()",
    "(<token>",
    "(<token>) garbage",
    "(<token>) <https://app.invalid/dav/a> (<other>)",
    "<relative> (<token>)",
    "<http://user@app.invalid/dav/a> (<token>)",
    "<https://app.invalid/dav/a#fragment> (<token>)",
    "(not <token>)",
    "(Not<token>)",
    "([etag])",
    '(["white space"])',
    "(<a>) , (<b>)",
    `(${Array.from({ length: 17 }, (_, index) => `<token:${index}>`).join(" ")})`,
    Array.from({ length: 17 }, (_, index) => `(<token:${index}>)`).join(" "),
    "x".repeat(8193),
  ])
    expect(() => parseDavIfHeader(value)).toThrow("invalid_dav_if");
});

it("parses one Lock-Token state token and rejects combined values", () => {
  expect(parseDavLockTokenHeader(null)).toBeNull();
  expect(parseDavLockTokenHeader(" <opaquelocktoken:abc> ")).toBe("opaquelocktoken:abc");
  for (const value of ["", "opaquelocktoken:abc", "<a><b>", "<a>, <b>", "<a b>"])
    expect(() => parseDavLockTokenHeader(value)).toThrow("invalid_dav_lock_token");
});

it("evaluates condition AND and all tagged/list productions as OR independently of submission", async () => {
  const states = new Map([
    ["https://app.invalid/dav/a", { tokens: new Set(["opaquelocktoken:a"]), etag: '"a"' }],
    ["https://app.invalid/dav/b", { tokens: new Set<string>(), etag: 'W/"b"' }],
  ]);
  const load = async (resource: string) => {
    const state = states.get(resource);
    if (!state) throw new Error("missing_state");
    return state;
  };
  await expect(
    evaluateDavIf(
      parseDavIfHeader(
        '<https://app.invalid/dav/a> (<wrong>) (<opaquelocktoken:a> ["a"]) <https://app.invalid/dav/b> ([W/"b"] Not <DAV:no-lock>)',
      ),
      "https://app.invalid/dav/request",
      load,
    ),
  ).resolves.toBe(true);
  await expect(
    evaluateDavIf(
      parseDavIfHeader('<https://app.invalid/dav/a> (<wrong>) <https://app.invalid/dav/b> (["b"])'),
      "https://app.invalid/dav/request",
      load,
    ),
  ).resolves.toBe(false);
  await expect(
    evaluateDavIf(
      parseDavIfHeader(
        '<https://app.invalid/dav/a> (<wrong>) <https://app.invalid/dav/b> ([W/"b"])',
      ),
      "https://app.invalid/dav/request",
      load,
    ),
  ).resolves.toBe(true);
  expect(parseDavIfHeader("(<false>) (<opaquelocktoken:a>)")?.submittedTokens).toEqual([
    "false",
    "opaquelocktoken:a",
  ]);
  await expect(
    evaluateDavIf(
      parseDavIfHeader("(<false>) (<opaquelocktoken:a>)"),
      "https://app.invalid/dav/a",
      load,
    ),
  ).resolves.toBe(true);
});
