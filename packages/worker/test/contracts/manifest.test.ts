import type { RouteMethod } from "@ncf/shared";
import { describe, expect, it } from "vitest";

import { app } from "../../src/index.js";
import { routeKey, routeManifest } from "../../src/routes/manifest.js";

describe("route manifest", () => {
  it("contains unique method-template pairs", () => {
    const keys = routeManifest.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not register a Hono route absent from the manifest", () => {
    const manifestKeys = new Set(routeManifest.map(routeKey));
    const registered = app.routes.map((registeredRoute) =>
      routeKey({ method: registeredRoute.method as RouteMethod, template: registeredRoute.path }),
    );
    expect(registered.every((key) => manifestKeys.has(key))).toBe(true);
  });

  it("does not expose a client thumbnail upload route", () => {
    expect(
      routeManifest.some((definition) => definition.template.includes("client-thumbnail")),
    ).toBe(false);
  });
});
