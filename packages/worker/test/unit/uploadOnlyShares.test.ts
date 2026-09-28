import { uploadOnlyShareInput } from "@next-cloud-flare/shared/uploadOnlyShares";
import { expect, it } from "vitest";

const input = { kind: "upload_only", rootNodeId: "folder", reservationLimit: 1024 };
it.each([0, 1024, 7_505_999_378_950_825])(
  "validates the explicit reservation limit %s",
  (reservationLimit) => {
    expect(uploadOnlyShareInput({ ...input, reservationLimit })).toEqual({
      ...input,
      reservationLimit,
      expiresAt: null,
    });
  },
);
it.each([
  { reservationLimit: undefined },
  { reservationLimit: -1 },
  { reservationLimit: 1.5 },
  { reservationLimit: "1024" },
  { reservationLimit: Number.NaN },
  { reservationLimit: Infinity },
  { reservationLimit: 7_505_999_378_950_826 },
  { role: "edit" },
  { kind: "link" },
  { rootNodeId: "a/b" },
  { expiresAt: 1 },
  { expiresAt: Number.MAX_SAFE_INTEGER },
  { password: "" },
  { password: "p".repeat(1025) },
  { password: "\ud800" },
  { rotateSecret: true },
  { reservedBytes: 0 },
  { ownerId: "other" },
])("rejects invalid or forbidden input %j", (extra) => {
  expect(() => uploadOnlyShareInput({ ...input, ...extra })).toThrow("invalid_share_request");
});
it("preserves omitted password and accepts explicit removal/rotation only on updates", () => {
  expect(uploadOnlyShareInput(input, true)).not.toHaveProperty("password");
  expect(
    uploadOnlyShareInput({ ...input, password: null, rotateSecret: true }, true),
  ).toMatchObject({ password: null, rotateSecret: true });
  expect(uploadOnlyShareInput({ ...input, password: "🔑秘密" }, true)).toMatchObject({
    password: "🔑秘密",
  });
  expect(() => uploadOnlyShareInput({ ...input, rotateSecret: 1 }, true)).toThrow(
    "invalid_share_request",
  );
});
