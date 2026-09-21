import { Hono } from "hono";

import { BudgetDO } from "./do/BudgetDO.js";
import { ControlDO } from "./do/ControlDO.js";
import { LockDO } from "./do/LockDO.js";
import { UploadDO } from "./do/UploadDO.js";
import type { Env } from "./env.js";
import { registerPhaseOneRoutes } from "./routes/register.js";

export const app = new Hono<{ Bindings: Env }>();

registerPhaseOneRoutes(app);

app.notFound((context) =>
  context.json({ error: { code: "not_found", message: "Route not found" } }, 404),
);

export { BudgetDO, ControlDO, LockDO, UploadDO };

export default {
  fetch: app.fetch,
  queue(): Promise<void> {
    return Promise.resolve();
  },
  scheduled(): Promise<void> {
    return Promise.resolve();
  },
} satisfies ExportedHandler<Env>;
