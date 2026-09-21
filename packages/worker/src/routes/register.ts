import type { Hono } from "hono";

import type { Env } from "../env.js";
import { phaseOneRoutes } from "./manifest.js";

export function registerPhaseOneRoutes(app: Hono<{ Bindings: Env }>): void {
  for (const definition of phaseOneRoutes) {
    app.on(definition.method, definition.template, (context) =>
      context.json(
        {
          error: {
            code: "foundation_unavailable",
            message: "The authenticated HTTP adapter is not enabled",
          },
        },
        503,
      ),
    );
  }
}
