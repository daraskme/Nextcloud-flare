import type { Context } from "hono";

import type { Env } from "../env.js";

export type AppContext = Context<{ Bindings: Env }>;

export function jsonError(
  context: AppContext,
  status: 400 | 401 | 403 | 404 | 409 | 411 | 412 | 413 | 423 | 428 | 500 | 503 | 507,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}

export function mapError(context: AppContext, error: unknown): Response {
  const message = error instanceof Error ? error.message : "internal_error";
  if (message.includes("UNIQUE constraint") || message === "name_conflict") {
    return jsonError(context, 409, "name_conflict", "An item with this name already exists");
  }
  if (message === "node_not_found" || message === "space_not_found") {
    return jsonError(context, 404, "not_found", "The requested item was not found");
  }
  if (message === "not_a_folder") {
    return jsonError(context, 409, "not_a_folder", "The destination is not a folder");
  }
  if (message.includes("access") || message.includes("jwt") || message.includes("token_required")) {
    return jsonError(context, 401, "authentication_required", "Authentication failed");
  }
  if (message.includes("development_principal") || message.includes("configuration_invalid")) {
    return jsonError(context, 503, "configuration_invalid", "The server configuration is invalid");
  }
  if (message === "locked") {
    return jsonError(context, 423, "locked", "The item is locked");
  }
  if (error instanceof RangeError) {
    return jsonError(context, 400, "invalid_input", error.message);
  }
  return jsonError(context, 409, "mutation_rejected", "The operation could not be committed");
}
