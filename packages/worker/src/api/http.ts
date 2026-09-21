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
  if (
    message === "node_not_found" ||
    message === "space_not_found" ||
    message === "upload_not_found" ||
    message === "upload_capability_required"
  ) {
    return jsonError(context, 404, "not_found", "The requested item was not found");
  }
  if (message === "upload_commit_unknown") {
    return jsonError(context, 503, "commit_unknown", "Upload completion is being reconciled");
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
  if (message === "completing_abort_forbidden" || message === "completed_abort_forbidden") {
    return jsonError(context, 409, "upload_terminal_conflict", "This upload cannot be aborted");
  }
  if (message === "upload_size_mismatch") {
    return jsonError(
      context,
      409,
      "upload_size_mismatch",
      "Uploaded bytes do not match the declaration",
    );
  }
  if (message === "locked") {
    return jsonError(context, 423, "locked", "The item is locked");
  }
  if (error instanceof RangeError) {
    return jsonError(context, 400, "invalid_input", error.message);
  }
  return jsonError(context, 409, "mutation_rejected", "The operation could not be committed");
}
