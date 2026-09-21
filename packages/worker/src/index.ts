import { Hono } from "hono";

import { PlaceholderDurableObject } from "./do/placeholder.js";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

app.notFound((context) =>
  context.json({ error: { code: "not_found", message: "Route not found" } }, 404),
);

export class ControlDO extends PlaceholderDurableObject {}
export class LockDO extends PlaceholderDurableObject {}
export class UploadDO extends PlaceholderDurableObject {}
export class BudgetDO extends PlaceholderDurableObject {}

export default {
  fetch: app.fetch,
  queue(): Promise<void> {
    return Promise.resolve();
  },
  scheduled(): Promise<void> {
    return Promise.resolve();
  },
} satisfies ExportedHandler<Env>;
