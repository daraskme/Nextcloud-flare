import { describe, expect, it } from "vitest";
import { internalShareInput, selectedShare } from "../../../shared/src/shares";

const input = {
  kind: "internal",
  rootNodeId: "node-1",
  recipients: ["Test@Example.invalid"],
  role: "read",
};
it("normalizes share recipients and an omitted expiry", () => {
  expect(internalShareInput(input)).toEqual({
    ...input,
    recipients: ["test@example.invalid"],
    expiresAt: null,
  });
});

describe("selected share authority", () => {
  it("copies and freezes the selected version so callers cannot change a proof", () => {
    const input = { id: "share_1", version: 1 };
    const selection = selectedShare(input);
    input.version = 2;
    expect(selection).toEqual({ id: "share_1", version: 1 });
    expect(Object.isFrozen(selection)).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { id: "share_1" },
    { id: "share_1", version: "1" },
    { id: "share_1", version: 0 },
    { id: "share_1", version: -1 },
    { id: "share_1", version: 1.5 },
    { id: "share_1", version: Number.MAX_SAFE_INTEGER + 1 },
    { id: "share_1", version: Number.NaN },
    { id: "../share", version: 1 },
    { id: "", version: 1 },
    { id: "s".repeat(129), version: 1 },
    { id: "share_1", version: 1, ownerId: "other" },
  ])("rejects malformed or ambiguous authority %#", (value) => {
    expect(() => selectedShare(value)).toThrow("invalid_share_selection");
  });
});
describe("bounded internal share input", () => {
  it.each([
    null,
    [],
    { ...input, role: "admin" },
    { ...input, kind: "link" },
    { ...input, rootNodeId: "../escape" },
    { ...input, recipients: [] },
    { ...input, recipients: ["a@b.c", "A@B.C"] },
    { ...input, recipients: ["not an email"] },
    { ...input, recipients: ["a@b.c\n"] },
    { ...input, recipients: Array.from({ length: 21 }, (_, i) => `u${i}@b.c`) },
    { ...input, expiresAt: Date.now() - 1000 },
    { ...input, expiresAt: 1.5 },
    { ...input, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, expiresAt: Number.MAX_SAFE_INTEGER },
    { ...input, extra: true },
  ])("rejects invalid input %#", (value) =>
    expect(() => internalShareInput(value)).toThrow("invalid_share_request"),
  );
});
