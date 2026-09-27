import { describe, expect, it } from "vitest";
import { internalShareInput } from "../../../shared/src/shares";

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
