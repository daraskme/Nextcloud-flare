import type { Hono } from "hono";

import { enforceCsrf, handleCsrf, handleLogout, handleOperation } from "../api/account.js";
import { handleContent, handlePutContent } from "../api/content.js";
import {
  handleChildren,
  handleCopy,
  handleCreateFolder,
  handleGetNode,
  handleMe,
  handleMove,
  handlePath,
  handleRename,
} from "../api/nodes.js";
import type { AppContext } from "../api/http.js";
import {
  handleAbortUpload,
  handleCompleteUpload,
  handleCreateUpload,
  handleGetUpload,
  handleSingleContent,
  handleUploadPart,
} from "../api/uploads.js";
import type { Env } from "../env.js";
import { routeKey, routesThroughPhase, type RouteDefinition } from "./manifest.js";

type RouteHandler = (context: AppContext) => Response | Promise<Response>;

const handlers = new Map<string, RouteHandler>([
  ["GET /api/v1/me", handleMe],
  ["POST /api/v1/auth/logout", handleLogout],
  ["POST /api/v1/csrf", handleCsrf],
  ["GET /api/v1/operations/:id", handleOperation],
  ["GET /api/v1/nodes/:nodeId", handleGetNode],
  ["GET /api/v1/nodes/:nodeId/path", handlePath],
  ["GET /api/v1/nodes/:nodeId/children", handleChildren],
  ["GET /api/v1/nodes/:nodeId/content", handleContent],
  ["HEAD /api/v1/nodes/:nodeId/content", handleContent],
  ["POST /api/v1/nodes", handleCreateFolder],
  ["PATCH /api/v1/nodes/:nodeId", handleRename],
  ["PUT /api/v1/nodes/:nodeId/content", handlePutContent],
  ["POST /api/v1/nodes/:nodeId/move", handleMove],
  ["POST /api/v1/nodes/:nodeId/copy", handleCopy],
  ["POST /api/v1/uploads", handleCreateUpload],
  ["GET /api/v1/uploads/:uploadId", handleGetUpload],
  ["PUT /api/v1/uploads/:uploadId/content", handleSingleContent],
  ["PUT /api/v1/uploads/:uploadId/parts/:partNumber", handleUploadPart],
  ["POST /api/v1/uploads/:uploadId/complete", handleCompleteUpload],
  ["DELETE /api/v1/uploads/:uploadId", handleAbortUpload],
]);

function isMutation(definition: RouteDefinition): boolean {
  return (
    !["GET", "HEAD", "OPTIONS"].includes(definition.method) &&
    definition.csrf === "same-origin-json"
  );
}

export function registerRoutes(
  app: Hono<{ Bindings: Env }>,
  phase: RouteDefinition["phase"],
): void {
  for (const definition of routesThroughPhase(phase)) {
    const handler = handlers.get(routeKey(definition));
    app.on(definition.method, definition.template, async (context) => {
      if (handler === undefined) {
        return context.json(
          {
            error: {
              code: "feature_unavailable",
              message: "This route is not enabled in the current implementation phase",
            },
          },
          503,
        );
      }
      if (isMutation(definition) && definition.operation !== "csrf.issue") {
        const rejected = await enforceCsrf(context);
        if (rejected !== null) {
          return rejected;
        }
      }
      return handler(context);
    });
  }
}
