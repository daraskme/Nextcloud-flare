import { describe, expect, it } from "vitest";
import { publicAssets } from "../../src/assets/publicManifest";
import { publicShareAssetRoute } from "../../src/assets/publicShare";
import {
  privateSpaPath,
  ROUTE_BINDINGS,
  type RouteBinding,
  verifyRouteBindings,
} from "../../src/routes/bindings";
import { ROUTES } from "../../src/routes/manifest";

function replaceBinding(key: string, update: Partial<RouteBinding>): RouteBinding[] {
  return ROUTE_BINDINGS.map((binding) =>
    binding.key === key ? { ...binding, ...update } : { ...binding },
  );
}

describe("route binding coverage", () => {
  it("classifies every generated contract exactly once", () => {
    expect(verifyRouteBindings(ROUTES, ROUTE_BINDINGS)).toEqual([]);
    expect(ROUTE_BINDINGS).toHaveLength(ROUTES.length);
  });

  it("binds only public media metadata while direct public blob routes stay unavailable", () => {
    const binding = (key: string) => ROUTE_BINDINGS.find((route) => route.key === key);
    for (const key of [
      "app GET /api/v1/public/shares/:shareId/gallery",
      "app GET /api/v1/public/shares/:shareId/tracks",
    ])
      expect(binding(key)).toMatchObject({
        availability: "bound",
        handler: "public-share",
        auth: ["share"],
      });
    for (const key of [
      "app GET /api/v1/public/shares/:shareId/content/:nodeId",
      "app GET /api/v1/public/shares/:shareId/thumb/:nodeId",
    ])
      expect(binding(key)).toMatchObject({
        availability: "unavailable",
        handler: "unavailable",
      });
  });

  it("binds private media state without exposing public-share state routes", () => {
    for (const key of [
      "app GET /api/v1/nodes/:nodeId/playback-state",
      "app PUT /api/v1/nodes/:nodeId/playback-state",
      "app GET /api/v1/library/:nodeId/reading-state",
      "app PUT /api/v1/library/:nodeId/reading-state",
    ])
      expect(ROUTE_BINDINGS.find((binding) => binding.key === key)).toMatchObject({
        availability: "bound",
        handler: "private-app",
        auth: ["access"],
      });
    expect(
      ROUTE_BINDINGS.some(
        (binding) =>
          binding.key.includes("/public/shares/") &&
          (binding.key.includes("playback-state") || binding.key.includes("reading-state")),
      ),
    ).toBe(false);
  });

  it("rejects missing and duplicate bindings", () => {
    const missing = ROUTE_BINDINGS.slice(1);
    expect(verifyRouteBindings(ROUTES, missing)).toContain(
      `missing binding: ${ROUTE_BINDINGS[0]?.key}`,
    );
    const duplicate = [...ROUTE_BINDINGS, ROUTE_BINDINGS[0]!];
    expect(verifyRouteBindings(ROUTES, duplicate)).toContain(
      `duplicate binding: ${ROUTE_BINDINGS[0]?.key}`,
    );
  });

  it.each([
    ["host", "app GET /api/v1/me", { host: "content" }, "host mismatch"],
    ["auth", "app GET /api/v1/me", { auth: ["public"] }, "auth mismatch"],
    ["admin", "app GET /api/v1/admin/dlq", { adminOnly: false }, "adminOnly mismatch"],
    ["csrf", "app POST /api/v1/csrf", { csrf: "same-origin-json" }, "csrf mismatch"],
  ] as const)("rejects a %s mismatch", (_field, key, update, message) => {
    expect(verifyRouteBindings(ROUTES, replaceBinding(key, update))).toContain(
      `${message}: ${key}`,
    );
  });

  it.each([
    ["app GET /public-assets/:asset", { cache: "private-no-store" }, "cache mismatch"],
    ["app GET /", { fallback: "none" }, "fallback mismatch"],
    ["content GET /reader-assets/:asset", { assetNamespace: "public" }, "asset namespace mismatch"],
  ] as const)("rejects an unsafe delivery policy for %s", (key, update, message) => {
    expect(verifyRouteBindings(ROUTES, replaceBinding(key, update))).toContain(
      `${message}: ${key}`,
    );
  });

  it("limits the private SPA shell to its exact navigation paths", () => {
    for (const path of [
      "/",
      "/files",
      "/files/node_123",
      "/encryption",
      "/trash",
      "/shares",
      "/settings/webdav",
      "/shared/share_123",
      "/shared/share_123/folder_456",
    ])
      expect(privateSpaPath(path)).toBe(true);
    for (const path of [
      "/s/share",
      "/public-assets/app.js",
      "/api/v1/me",
      "/files/a/b",
      "/shared",
      "/shared/share/child/grandchild",
      "/unknown",
    ])
      expect(privateSpaPath(path)).toBe(false);
  });

  it("serves only exact public share shell and versioned asset paths", () => {
    for (const path of ["/s", "/s/share_123", ...publicAssets])
      expect(publicShareAssetRoute(new Request(`https://app.invalid${path}`))).toBe(true);
    for (const path of [
      "/s/share/child",
      "/private-assets/app.js",
      "/public-assets/unknown.js",
      "/api/v1/public/shares/share_123",
    ])
      expect(publicShareAssetRoute(new Request(`https://app.invalid${path}`))).toBe(false);
  });

  it("binds public EPUB metadata and content-origin page and entry delivery", () => {
    const selected = new Map(
      ROUTE_BINDINGS.filter(
        (binding) =>
          binding.key.includes("/api/v1/public/shares/:shareId/library/") ||
          binding.key.includes("/c/:nodeId/:blobId/pages/") ||
          binding.key.includes("/c/:nodeId/:blobId/entries/"),
      ).map((binding) => [binding.key, binding]),
    );
    expect([...selected.values()]).toHaveLength(9);
    for (const binding of selected.values()) {
      expect(binding.availability).toBe("bound");
      expect(binding.handler).toMatch(/^(?:public-share|content)$/);
    }
    expect(
      ROUTE_BINDINGS.find(
        (binding) => binding.key === "app GET /api/v1/public/shares/:shareId/gallery",
      ),
    ).toMatchObject({ availability: "bound", handler: "public-share" });
  });

  it("binds private ZIP creation and redirect through the private app", () => {
    for (const key of ["app POST /api/v1/nodes/:nodeId/zip", "app GET /api/v1/zips/:id"])
      expect(ROUTE_BINDINGS.find((binding) => binding.key === key)).toMatchObject({
        availability: "bound",
        handler: "private-app",
        auth: ["access"],
      });
  });
});
