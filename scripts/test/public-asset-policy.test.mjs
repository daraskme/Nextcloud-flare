import { expect, it } from "vitest";
import { assertPublicModule, assertPublicSource, isPublicSource } from "../public-asset-policy.mjs";

it("permits only the independent public entry and pinned rendering runtime", () => {
  for (const id of [
    "/web/public.html",
    "/web/src/public-share/main.tsx",
    "/shared/src/zips.ts",
    "/shared/src/mediaExtraction.ts",
    "/web/node_modules/react/index.js",
    "\0vite/modulepreload-polyfill.js",
    "C:\\web\\src\\public-share\\client.ts",
  ]) {
    expect(() => assertPublicModule(id, id.startsWith("C:") ? "C:\\web\\" : "/web/")).not.toThrow();
  }
  for (const id of [
    "/web/src/lib/api.ts",
    "/web/src/features/auth/client.ts",
    "/web/src/public-share-evil/main.ts",
    "/web/test/fixture.ts",
    "/worker/src/env.ts",
    "/shared/src/shares.ts",
    "/shared/src/zips-evil.ts",
    "/shared/src/mediaExtraction-evil.ts",
    "/other/shared/src/mediaExtraction.ts",
    "/web/node_modules/jose/index.js",
    "/web/index.html",
  ]) {
    expect(() => assertPublicModule(id, "/web/")).toThrow("forbidden public module");
  }
});
it("checks the allowlisted ZIP utility source and its Windows path", () => {
  expect(isPublicSource("/shared/src/zips.ts")).toBe(true);
  expect(isPublicSource("C:\\shared\\src\\zips.ts")).toBe(true);
  expect(() => assertPublicModule("C:\\shared\\src\\zips.ts", "C:\\web\\")).not.toThrow();
  expect(() => assertPublicModule("/other/shared/src/zips.ts", "/web/")).toThrow();
  expect(isPublicSource("/shared/src/shares.ts")).toBe(false);
});
it("checks the pure media receipt source on both path platforms", () => {
  expect(isPublicSource("/shared/src/mediaExtraction.ts")).toBe(true);
  expect(isPublicSource("C:\\shared\\src\\mediaExtraction.ts")).toBe(true);
  expect(() =>
    assertPublicModule("C:\\shared\\src\\mediaExtraction.ts", "C:\\web\\"),
  ).not.toThrow();
  expect(() => assertPublicModule("/other/shared/src/mediaExtraction.ts", "/web/")).toThrow();
});
it("rejects private headers, environment substitution, test controls and unsafe rendering", () => {
  for (const source of [
    "Cf-Access-Jwt-Assertion",
    "import.meta.env.VITE_SECRET",
    "dangerouslySetInnerHTML",
    "navigator.serviceWorker",
    "__test__/login",
    "CSRF_PRIVATE_KEYS",
  ]) {
    expect(() => assertPublicSource(source)).toThrow("forbidden public source");
  }
});
