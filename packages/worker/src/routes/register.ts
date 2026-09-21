import type { Hono } from "hono";

import { enforceCsrf, handleCsrf, handleLogout, handleOperation } from "../api/account.js";
import {
  handleRecent,
  handleSearch,
  handleSetStar,
  handleStarred,
  handleStats,
} from "../api/discovery.js";
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
import { handleCreateTag, handleDeleteTag, handleListTags, handleUpdateTag } from "../api/tags.js";
import {
  handleListTrash,
  handlePurgeTrash,
  handleRestoreTrash,
  handleTrashNode,
} from "../api/trash.js";
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
  ["GET /api/v1/search", handleSearch],
  ["GET /api/v1/recent", handleRecent],
  ["GET /api/v1/starred", handleStarred],
  ["GET /api/v1/stats", handleStats],
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
  ["PUT /api/v1/nodes/:nodeId/star", handleSetStar],
  ["DELETE /api/v1/nodes/:nodeId", handleTrashNode],
  ["POST /api/v1/uploads", handleCreateUpload],
  ["GET /api/v1/uploads/:uploadId", handleGetUpload],
  ["PUT /api/v1/uploads/:uploadId/content", handleSingleContent],
  ["PUT /api/v1/uploads/:uploadId/parts/:partNumber", handleUploadPart],
  ["POST /api/v1/uploads/:uploadId/complete", handleCompleteUpload],
  ["DELETE /api/v1/uploads/:uploadId", handleAbortUpload],
  ["GET /api/v1/trash", handleListTrash],
  ["POST /api/v1/trash/:opId/restore", handleRestoreTrash],
  ["POST /api/v1/trash/:opId/purge", handlePurgeTrash],
  ["GET /api/v1/tags", handleListTags],
  ["POST /api/v1/tags", handleCreateTag],
  ["PATCH /api/v1/tags/:tagId", handleUpdateTag],
  ["DELETE /api/v1/tags/:tagId", handleDeleteTag],
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
