import { expect, it } from "vitest";
import {
  parseDavDestination,
  parseDavOverwrite,
  parseDavTransferDepth,
} from "../../src/dav/transferProtocol";

it("parses a same-origin DAV destination without normalizing its path twice", () => {
  expect(
    parseDavDestination("https://app.invalid/dav/folder/a%20b.txt", "https://app.invalid"),
  ).toEqual({
    href: "https://app.invalid/dav/folder/a%20b.txt",
    path: {
      segments: [
        { name: "folder", nameCi: "folder", hidden: false },
        { name: "a b.txt", nameCi: "a b.txt", hidden: false },
      ],
      trailingSlash: false,
    },
  });
});

it("rejects ambiguous, external, or normalized Destination values", () => {
  for (const value of [
    null,
    "http://app.invalid/dav/a",
    "https://other.invalid/dav/a",
    "https://user@app.invalid/dav/a",
    "https://app.invalid/dav/a?query",
    "https://app.invalid/dav/a#fragment",
    "https://app.invalid/dav/a,https://app.invalid/dav/b",
    "https://app.invalid/dav/../secret",
    "https://app.invalid/dav/%2e%2e/secret",
    "https://app.invalid/dav/a%2fb",
    "https://app.invalid/dav/a%5cb",
    "https://app.invalid\\dav\\a",
    "https://app.invalid/dav/%252e%252e",
    `https://app.invalid/dav/${"a".repeat(8_193)}`,
  ])
    expect(() => parseDavDestination(value, "https://app.invalid")).toThrow(
      "invalid_dav_destination",
    );
});

it("applies COPY and MOVE Overwrite and Depth defaults", () => {
  expect(parseDavOverwrite(null)).toBe(true);
  expect(parseDavOverwrite("T")).toBe(true);
  expect(parseDavOverwrite("F")).toBe(false);
  for (const value of ["", "true", "t", "T,F"])
    expect(() => parseDavOverwrite(value)).toThrow("invalid_dav_overwrite");

  expect(parseDavTransferDepth("COPY", null)).toBe("infinity");
  expect(parseDavTransferDepth("COPY", "0")).toBe("0");
  expect(parseDavTransferDepth("COPY", "Infinity")).toBe("infinity");
  expect(parseDavTransferDepth("MOVE", null)).toBe("infinity");
  expect(parseDavTransferDepth("MOVE", "infinity")).toBe("infinity");
  for (const [method, value] of [
    ["MOVE", "0"],
    ["COPY", "1"],
    ["MOVE", "1"],
  ] as const)
    expect(() => parseDavTransferDepth(method, value)).toThrow("invalid_dav_depth");
});
