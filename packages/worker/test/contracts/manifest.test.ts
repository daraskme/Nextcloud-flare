import type { RouteMethod } from "@ncf/shared";
import { describe, expect, it } from "vitest";

import { app } from "../../src/index.js";
import { routeKey, routeManifest, routesThroughPhase } from "../../src/routes/manifest.js";
import { handlers } from "../../src/routes/register.js";

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

  it("only leaves the known deferred routes without a handler", () => {
    const deferred = [
      "GET /",
      "GET /assets/:asset",
      "GET /api/v1/jobs/:jobId",
      "POST /api/v1/jobs/:jobId/cancel",
      "POST /api/v1/jobs/:jobId/retry",
      "GET /api/v1/admin/dlq",
      "POST /api/v1/admin/dlq/:jobId/requeue",
      "POST /api/v1/admin/users/:userId/disable",
      "POST /api/v1/admin/transfer",
      "POST /api/v1/admin/locks/:lockId/force-unlock",
      "GET /api/v1/automation/nodes",
      "GET /api/v1/automation/nodes/:nodeId",
      "POST /api/v1/public/shares/:shareId/nodes",
      "PATCH /api/v1/public/shares/:shareId/nodes/:nodeId",
      "DELETE /api/v1/public/shares/:shareId/nodes/:nodeId",
      "GET /c/:nodeId/:blobId/pages/:page",
      "HEAD /c/:nodeId/:blobId/pages/:page",
      "GET /c/:nodeId/:blobId/entries/:entryToken",
      "HEAD /c/:nodeId/:blobId/entries/:entryToken",
    ];
    const missing = routesThroughPhase(8)
      .map(routeKey)
      .filter((key) => !handlers.has(key));
    expect(missing).toEqual(deferred);
  });

  it("does not let a handler-less parameter route shadow a handled literal route", () => {
    const handled = routesThroughPhase(8).filter((definition) =>
      handlers.has(routeKey(definition)),
    );
    for (const definition of routesThroughPhase(8)) {
      if (handlers.has(routeKey(definition))) continue;
      const pattern = new RegExp(
        `^${definition.template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+")}$`,
      );
      const shadowed = handled.filter(
        (candidate) =>
          candidate.method === definition.method &&
          !candidate.template.includes(":") &&
          pattern.test(candidate.template),
      );
      expect(shadowed, `${routeKey(definition)} shadows`).toEqual([]);
    }
  });

  it("does not expose a client thumbnail upload route", () => {
    expect(
      routeManifest.some((definition) => definition.template.includes("client-thumbnail")),
    ).toBe(false);
  });
});
