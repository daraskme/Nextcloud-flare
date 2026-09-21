import type { Hono } from "hono";

import { enforceCsrf, handleCsrf, handleLogout, handleOperation } from "../api/account.js";
import {
  handleAudioCover,
  handlePlaybackState,
  handlePublicAudioCover,
  handlePublicTracks,
  handleTracks,
  handleUpdateAudio,
} from "../api/audio.js";
import {
  handleCancelPublicTicket,
  handleCancelTicket,
  handleContentSessionAccept,
  handleContentSessionOptions,
  handleContentSessionRead,
  handleCreateContentSession,
  handleCreatePublicContentSession,
} from "../api/contentSession.js";
import {
  handleCreateAppPassword,
  handleListAppPasswords,
  handleRevokeAppPassword,
} from "../api/credentials.js";
import {
  handleGallery,
  handlePublicGallery,
  handlePublicThumbnail,
  handleThumbnail,
} from "../api/gallery.js";
import {
  handleAddLibraryRoot,
  handleEpubEntry,
  handleLibraryCover,
  handleLibraryItem,
  handleLibraryItems,
  handleLibraryPage,
  handleLibraryRoots,
  handlePublicEpubEntry,
  handlePublicLibraryItem,
  handlePublicLibraryPage,
  handleReaderAsset,
  handleReaderShell,
  handleReadingState,
  handleRemoveLibraryRoot,
  handleUpdateLibraryItem,
} from "../api/library.js";
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
  handleListVersions,
  handleMe,
  handleMove,
  handlePath,
  handleRename,
  handleRestoreVersion,
} from "../api/nodes.js";
import type { AppContext } from "../api/http.js";
import {
  handleCreateShareUpload,
  handleCompleteShareUpload,
  handleAbortShareUpload,
  handleGetShareUpload,
  handlePutShareUpload,
  handleUnsupportedSharePart,
} from "../api/shareUploads.js";
import {
  handleCreateShare,
  handleDisableShare,
  handleGetShare,
  handleListShares,
  handleLogoutShare,
  handlePublicAsset,
  handlePublicChildren,
  handlePublicContent,
  handlePublicCsrf,
  handlePublicShare,
  handleSharedWithMe,
  handleShareLanding,
  handleUnlockShare,
  handleUpdateShare,
} from "../api/shares.js";
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
import {
  handleCreatePublicZip,
  handleCreateZip,
  handleDownloadPublicZip,
  handleDownloadZip,
} from "../api/zip.js";
import { verifyShareCsrf } from "../auth/share.js";
import { handleDav } from "../dav/methods.js";
import type { Env } from "../env.js";
import { routeKey, routesThroughPhase, type RouteDefinition } from "./manifest.js";

type RouteHandler = (context: AppContext) => Response | Promise<Response>;

export const handlers = new Map<string, RouteHandler>([
  ["GET /api/v1/me", handleMe],
  ["POST /api/v1/auth/logout", handleLogout],
  ["POST /api/v1/csrf", handleCsrf],
  ["GET /api/v1/operations/:id", handleOperation],
  ["GET /api/v1/search", handleSearch],
  ["GET /api/v1/recent", handleRecent],
  ["GET /api/v1/starred", handleStarred],
  ["GET /api/v1/stats", handleStats],
  ["GET /api/v1/shared-with-me", handleSharedWithMe],
  ["GET /api/v1/shares", handleListShares],
  ["POST /api/v1/shares", handleCreateShare],
  ["GET /api/v1/shares/:shareId", handleGetShare],
  ["PATCH /api/v1/shares/:shareId", handleUpdateShare],
  ["DELETE /api/v1/shares/:shareId", handleDisableShare],
  ["POST /api/v1/content-session", handleCreateContentSession],
  ["DELETE /api/v1/tickets/:ticketId", handleCancelTicket],
  ["GET /api/v1/app-passwords", handleListAppPasswords],
  ["POST /api/v1/app-passwords", handleCreateAppPassword],
  ["DELETE /api/v1/app-passwords/:credentialId", handleRevokeAppPassword],
  ["GET /public-assets/:asset", handlePublicAsset],
  ["GET /s", handleShareLanding],
  ["GET /s/:shareId", handleShareLanding],
  ["GET /api/v1/nodes/:nodeId", handleGetNode],
  ["GET /api/v1/nodes/:nodeId/path", handlePath],
  ["GET /api/v1/nodes/:nodeId/children", handleChildren],
  ["GET /api/v1/nodes/:nodeId/versions", handleListVersions],
  ["POST /api/v1/nodes/:nodeId/versions/:versionId/restore", handleRestoreVersion],
  ["GET /api/v1/nodes/:nodeId/content", handleContent],
  ["HEAD /api/v1/nodes/:nodeId/content", handleContent],
  ["GET /api/v1/nodes/:nodeId/thumb", handleThumbnail],
  ["HEAD /api/v1/nodes/:nodeId/thumb", handleThumbnail],
  ["GET /api/v1/nodes/:nodeId/preview", handleThumbnail],
  ["HEAD /api/v1/nodes/:nodeId/preview", handleThumbnail],
  ["GET /api/v1/nodes/:nodeId/gallery", handleGallery],
  ["GET /api/v1/nodes/:nodeId/tracks", handleTracks],
  ["GET /api/v1/nodes/:nodeId/audio/cover", handleAudioCover],
  ["HEAD /api/v1/nodes/:nodeId/audio/cover", handleAudioCover],
  ["PATCH /api/v1/nodes/:nodeId/audio", handleUpdateAudio],
  ["PUT /api/v1/nodes/:nodeId/playback-state", handlePlaybackState],
  ["GET /api/v1/library/items", handleLibraryItems],
  ["GET /api/v1/library/items/:itemId", handleLibraryItem],
  ["PATCH /api/v1/library/items/:itemId", handleUpdateLibraryItem],
  ["GET /api/v1/library/items/:itemId/pages/:page", handleLibraryPage],
  ["HEAD /api/v1/library/items/:itemId/pages/:page", handleLibraryPage],
  ["GET /api/v1/library/items/:itemId/cover", handleLibraryCover],
  ["HEAD /api/v1/library/items/:itemId/cover", handleLibraryCover],
  ["GET /api/v1/library/items/:itemId/entries/:entryId", handleEpubEntry],
  ["HEAD /api/v1/library/items/:itemId/entries/:entryId", handleEpubEntry],
  ["PUT /api/v1/library/items/:itemId/reading-state", handleReadingState],
  ["GET /api/v1/library/roots", handleLibraryRoots],
  ["POST /api/v1/library/roots", handleAddLibraryRoot],
  ["DELETE /api/v1/library/roots/:nodeId", handleRemoveLibraryRoot],
  ["GET /reader/index.html", handleReaderShell],
  ["GET /reader/:asset", handleReaderShell],
  ["GET /reader-assets/:asset", handleReaderAsset],
  ["POST /api/v1/nodes", handleCreateFolder],
  ["PATCH /api/v1/nodes/:nodeId", handleRename],
  ["PUT /api/v1/nodes/:nodeId/content", handlePutContent],
  ["POST /api/v1/nodes/:nodeId/move", handleMove],
  ["POST /api/v1/nodes/:nodeId/copy", handleCopy],
  ["PUT /api/v1/nodes/:nodeId/star", handleSetStar],
  ["POST /api/v1/nodes/:nodeId/zip", handleCreateZip],
  ["GET /api/v1/zips/:id", handleDownloadZip],
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
  ["GET /api/v1/public/shares/:shareId", handlePublicShare],
  ["GET /api/v1/public/shares/:shareId/children/:nodeId", handlePublicChildren],
  ["GET /api/v1/public/shares/:shareId/content/:nodeId", handlePublicContent],
  ["HEAD /api/v1/public/shares/:shareId/content/:nodeId", handlePublicContent],
  ["GET /api/v1/public/shares/:shareId/thumb/:nodeId", handlePublicThumbnail],
  ["HEAD /api/v1/public/shares/:shareId/thumb/:nodeId", handlePublicThumbnail],
  ["GET /api/v1/public/shares/:shareId/gallery", handlePublicGallery],
  ["GET /api/v1/public/shares/:shareId/tracks", handlePublicTracks],
  ["GET /api/v1/public/shares/:shareId/audio/:nodeId/cover", handlePublicAudioCover],
  ["HEAD /api/v1/public/shares/:shareId/audio/:nodeId/cover", handlePublicAudioCover],
  ["GET /api/v1/public/shares/:shareId/library/:nodeId", handlePublicLibraryItem],
  ["GET /api/v1/public/shares/:shareId/library/:nodeId/pages/:page", handlePublicLibraryPage],
  ["HEAD /api/v1/public/shares/:shareId/library/:nodeId/pages/:page", handlePublicLibraryPage],
  ["GET /api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken", handlePublicEpubEntry],
  [
    "HEAD /api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken",
    handlePublicEpubEntry,
  ],
  ["POST /api/v1/public/shares/:shareId/csrf", handlePublicCsrf],
  ["POST /api/v1/public/shares/:shareId/unlock", handleUnlockShare],
  ["POST /api/v1/public/shares/:shareId/logout", handleLogoutShare],
  ["POST /api/v1/public/shares/:shareId/tickets", handleCreatePublicContentSession],
  ["DELETE /api/v1/public/shares/:shareId/tickets/:ticketId", handleCancelPublicTicket],
  ["POST /api/v1/public/shares/:shareId/content-session", handleCreatePublicContentSession],
  ["POST /api/v1/public/shares/:shareId/nodes/:nodeId/zip", handleCreatePublicZip],
  ["GET /api/v1/public/shares/:shareId/zips/:zipId", handleDownloadPublicZip],
  ["POST /api/v1/public/shares/:shareId/uploads", handleCreateShareUpload],
  ["GET /api/v1/public/shares/:shareId/uploads/:uploadId", handleGetShareUpload],
  ["PUT /api/v1/public/shares/:shareId/uploads/:uploadId/content", handlePutShareUpload],
  [
    "PUT /api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber",
    handleUnsupportedSharePart,
  ],
  ["POST /api/v1/public/shares/:shareId/uploads/:uploadId/complete", handleCompleteShareUpload],
  ["DELETE /api/v1/public/shares/:shareId/uploads/:uploadId", handleAbortShareUpload],
  ["OPTIONS /session", handleContentSessionOptions],
  ["POST /session", handleContentSessionAccept],
  ["GET /c/:nodeId/:blobId", handleContentSessionRead],
  ["HEAD /c/:nodeId/:blobId", handleContentSessionRead],
]);

for (const method of [
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
] as const) {
  handlers.set(`${method} /dav`, handleDav);
  handlers.set(`${method} /dav/*`, handleDav);
}

function isMutation(definition: RouteDefinition): boolean {
  return (
    !["GET", "HEAD", "OPTIONS"].includes(definition.method) &&
    definition.csrf === "same-origin-json"
  );
}

function isPublicMutation(definition: RouteDefinition): boolean {
  return (
    !["GET", "HEAD", "OPTIONS"].includes(definition.method) &&
    definition.csrf === "public-form" &&
    definition.operation !== "share.unlock"
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
      if (isPublicMutation(definition)) {
        const sameOrigin =
          context.req.header("Origin") === context.env.APP_ORIGIN &&
          context.req.header("Sec-Fetch-Site") === "same-origin";
        const shareId = context.req.param("shareId");
        const valid =
          sameOrigin && shareId !== undefined
            ? await verifyShareCsrf(context.env, context.req.raw, shareId).catch(() => false)
            : false;
        if (!valid) {
          return context.json(
            { error: { code: "csrf_failed", message: "The CSRF token is invalid" } },
            403,
          );
        }
      }
      return handler(context);
    });
  }
}
