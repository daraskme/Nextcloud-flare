import { linkShareInput, validSharePassword } from "@next-cloud-flare/shared/linkShares";
import { base64url } from "jose";
import { expect, it, vi } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { KdfUnavailableError } from "../../src/auth/kdf";
import {
  hashSharePassword,
  matchesSharePassword,
  newShareSecret,
  shareSecretDigest,
} from "../../src/auth/shareSecrets";
import { localKdf } from "../fixtures/kdf";

const input = { kind: "link", rootNodeId: "root", role: "read" };
it("binds random fragment capabilities to their share and requires canonical encoding", async () => {
  const secret = newShareSecret();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newShareSecret()).not.toBe(secret);
  const digest = await shareSecretDigest("share", secret);
  expect(digest).not.toBe(secret);
  expect(await shareSecretDigest("share", secret)).toBe(digest);
  expect(await shareSecretDigest("other", secret)).not.toBe(digest);
  await expect(shareSecretDigest("share", "A".repeat(42) + "B")).rejects.toThrow();
});
it("retains password omission, explicit removal, Unicode and the exact UTF-8 bound", () => {
  expect(linkShareInput(input)).toEqual({ ...input, expiresAt: null });
  expect(linkShareInput({ ...input, password: null }, true)).toHaveProperty("password", null);
  expect(validSharePassword("あ".repeat(341) + "a")).toBe(true);
  expect(validSharePassword("あ".repeat(342))).toBe(false);
  expect(validSharePassword("\ud800")).toBe(false);
  expect(validSharePassword("\uFEFFpassword")).toBe(true);
});
it.each([
  { kind: "internal" },
  { rootNodeId: "a/b" },
  { role: "admin" },
  { password: "" },
  { password: 42 },
  { password: "a".repeat(1025) },
  { expiresAt: 0 },
  { expiresAt: Number.MAX_SAFE_INTEGER },
  { recipients: ["person@example.com"] },
  { rotateSecret: true },
])("rejects an invalid link request %j", (patch) => {
  expect(() => linkShareInput({ ...input, ...patch })).toThrow("invalid_share_request");
});
it("checks real PBKDF2 output with a share-bound input and dual-read key ring", async () => {
  const one = base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    two = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const old = { ...(await contentKeyRing("old", { old: one })), derive: localKdf };
  const record = await hashSharePassword("share", " 日本語🔑 ", old);
  expect(record).toMatchObject({
    kdf: "PBKDF2-SHA256",
    kdfParams: '{"iterations":100000}',
    kid: "old",
  });
  expect(await matchesSharePassword("share", " 日本語🔑 ", record, old)).toBe(true);
  expect(await matchesSharePassword("share", "日本語🔑", record, old)).toBe(false);
  expect(await matchesSharePassword("other", " 日本語🔑 ", record, old)).toBe(false);
  const next = { ...(await contentKeyRing("next", { old: one, next: two })), derive: localKdf };
  expect(await matchesSharePassword("share", " 日本語🔑 ", record, next)).toBe(true);
  expect(await hashSharePassword("share", " 日本語🔑 ", next)).toHaveProperty("kid", "next");
  const revoked = { ...(await contentKeyRing("next", { next: two })), derive: localKdf };
  expect(await matchesSharePassword("share", " 日本語🔑 ", record, revoked)).toBe(false);
});
it("does not downgrade an unavailable KDF to an incorrect password", async () => {
  const ring = {
    ...(await contentKeyRing("v1", { v1: base64url.encode(new Uint8Array(32)) })),
    derive: localKdf,
  };
  const record = await hashSharePassword("share", "password", ring);
  const derive = vi.fn(async () => {
    throw new KdfUnavailableError();
  });
  await expect(
    matchesSharePassword("share", "password", record, { ...ring, derive }),
  ).rejects.toBeInstanceOf(KdfUnavailableError);
  expect(derive).toHaveBeenCalledOnce();
  await expect(
    hashSharePassword("share", "password", { ...ring, derive }, AbortSignal.abort()),
  ).rejects.toBeInstanceOf(KdfUnavailableError);
  expect(derive).toHaveBeenCalledOnce();
});
