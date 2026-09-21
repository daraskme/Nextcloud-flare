import type { Operation, RouteMethod } from "@ncf/shared";

export type RouteAuth =
  | "access"
  | "service"
  | "share"
  | "public"
  | "app_password"
  | "content_cookie";
export type CsrfProfile =
  | "same-origin-json"
  | "csrf-issue"
  | "public-csrf-issue"
  | "public-form"
  | "dav"
  | "cross-origin-content";

export interface RouteDefinition {
  host: "app" | "content";
  method: RouteMethod;
  template: string;
  auth: RouteAuth;
  operation: Operation;
  csrf: CsrfProfile;
  adminOnly: boolean;
  phase: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

const route = (
  method: RouteMethod,
  template: string,
  auth: RouteAuth,
  operation: Operation,
  phase: RouteDefinition["phase"],
  csrf: CsrfProfile = "same-origin-json",
  host: RouteDefinition["host"] = "app",
  adminOnly = false,
): RouteDefinition => ({ host, method, template, auth, operation, csrf, adminOnly, phase });

export const routeManifest = [
  route("GET", "/", "access", "spa.read", 7),
  route("GET", "/assets/:asset", "access", "spa.read", 7),
  route("GET", "/public-assets/:asset", "public", "public.asset.read", 6),
  route("GET", "/s", "public", "share.landing", 6),
  route("GET", "/s/:shareId", "public", "share.landing", 6),
  route("GET", "/api/v1/me", "access", "account.read", 1),
  route("POST", "/api/v1/auth/logout", "access", "account.logout", 1),
  route("POST", "/api/v1/csrf", "access", "csrf.issue", 1, "csrf-issue"),
  route("GET", "/api/v1/operations/:id", "access", "operation.read", 1),
  route("GET", "/api/v1/search", "access", "search.read", 5),
  route("GET", "/api/v1/recent", "access", "recent.read", 5),
  route("GET", "/api/v1/starred", "access", "starred.read", 5),
  route("GET", "/api/v1/shared-with-me", "access", "shared.read", 6),
  route("GET", "/api/v1/stats", "access", "account.read", 5),
  route("GET", "/api/v1/nodes/:nodeId", "access", "node.read", 2),
  route("GET", "/api/v1/nodes/:nodeId/path", "access", "node.read", 2),
  route("GET", "/api/v1/nodes/:nodeId/children", "access", "node.read", 2),
  route("GET", "/api/v1/nodes/:nodeId/versions", "access", "node.read", 2),
  route(
    "POST",
    "/api/v1/nodes/:nodeId/versions/:versionId/restore",
    "access",
    "node.content.write",
    2,
  ),
  route("GET", "/api/v1/nodes/:nodeId/content", "access", "node.read", 2),
  route("HEAD", "/api/v1/nodes/:nodeId/content", "access", "node.read", 2),
  route("GET", "/api/v1/nodes/:nodeId/thumb", "access", "node.read", 8),
  route("HEAD", "/api/v1/nodes/:nodeId/thumb", "access", "node.read", 8),
  route("GET", "/api/v1/nodes/:nodeId/preview", "access", "node.read", 8),
  route("HEAD", "/api/v1/nodes/:nodeId/preview", "access", "node.read", 8),
  route("POST", "/api/v1/nodes", "access", "node.create", 1),
  route("PATCH", "/api/v1/nodes/:nodeId", "access", "node.rename", 2),
  route("PUT", "/api/v1/nodes/:nodeId/content", "access", "node.content.write", 2),
  route("DELETE", "/api/v1/nodes/:nodeId", "access", "node.trash", 4),
  route("POST", "/api/v1/nodes/:nodeId/move", "access", "node.move", 2),
  route("POST", "/api/v1/nodes/:nodeId/copy", "access", "node.copy", 2),
  route("PUT", "/api/v1/nodes/:nodeId/star", "access", "node.star", 5),
  route("POST", "/api/v1/nodes/:nodeId/zip", "access", "zip.create", 6),
  route("GET", "/api/v1/zips/:id", "access", "zip.read", 6),
  route("GET", "/api/v1/nodes/:nodeId/gallery", "access", "gallery.read", 8),
  route("GET", "/api/v1/nodes/:nodeId/tracks", "access", "audio.read", 8),
  route("GET", "/api/v1/nodes/:nodeId/audio/cover", "access", "audio.read", 8),
  route("HEAD", "/api/v1/nodes/:nodeId/audio/cover", "access", "audio.read", 8),
  route("PATCH", "/api/v1/nodes/:nodeId/audio", "access", "audio.metadata.write", 8),
  route("PUT", "/api/v1/nodes/:nodeId/playback-state", "access", "playback_state.write", 8),
  route("GET", "/api/v1/library/items", "access", "library.read", 8),
  route("GET", "/api/v1/library/items/:itemId", "access", "library.read", 8),
  route("PATCH", "/api/v1/library/items/:itemId", "access", "library.write", 8),
  route("GET", "/api/v1/library/items/:itemId/pages/:page", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/items/:itemId/pages/:page", "access", "library.read", 8),
  route("GET", "/api/v1/library/items/:itemId/cover", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/items/:itemId/cover", "access", "library.read", 8),
  route("GET", "/api/v1/library/items/:itemId/entries/:entryId", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/items/:itemId/entries/:entryId", "access", "library.read", 8),
  route(
    "PUT",
    "/api/v1/library/items/:itemId/reading-state",
    "access",
    "reading_state.write",
    8,
  ),
  route("GET", "/api/v1/library/:nodeId", "access", "library.read", 8),
  route("GET", "/api/v1/library/:nodeId/pages/:page", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/:nodeId/pages/:page", "access", "library.read", 8),
  route("GET", "/api/v1/library/:nodeId/pages/:page/thumb", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/:nodeId/pages/:page/thumb", "access", "library.read", 8),
  route("GET", "/api/v1/library/:nodeId/entries/:entryToken", "access", "library.read", 8),
  route("HEAD", "/api/v1/library/:nodeId/entries/:entryToken", "access", "library.read", 8),
  route("PUT", "/api/v1/library/:nodeId/reading-state", "access", "reading_state.write", 8),
  route("GET", "/api/v1/library/roots", "access", "library.read", 8),
  route("POST", "/api/v1/library/roots", "access", "library.write", 8),
  route("DELETE", "/api/v1/library/roots/:nodeId", "access", "library.write", 8),
  route("POST", "/api/v1/uploads", "access", "upload.create", 3),
  route("GET", "/api/v1/uploads/:uploadId", "access", "upload.read", 3),
  route("PUT", "/api/v1/uploads/:uploadId/content", "access", "upload.write", 3),
  route("PUT", "/api/v1/uploads/:uploadId/parts/:partNumber", "access", "upload.write", 3),
  route("POST", "/api/v1/uploads/:uploadId/complete", "access", "upload.complete", 3),
  route("DELETE", "/api/v1/uploads/:uploadId", "access", "upload.abort", 3),
  route("GET", "/api/v1/trash", "access", "trash.read", 4),
  route("POST", "/api/v1/trash/:opId/restore", "access", "node.restore", 4),
  route("POST", "/api/v1/trash/:opId/purge", "access", "node.purge", 4),
  route("GET", "/api/v1/shares", "access", "share.read", 6),
  route("POST", "/api/v1/shares", "access", "share.manage", 6),
  route("GET", "/api/v1/shares/:shareId", "access", "share.read", 6),
  route("PATCH", "/api/v1/shares/:shareId", "access", "share.manage", 6),
  route("DELETE", "/api/v1/shares/:shareId", "access", "share.disable", 6),
  route("GET", "/api/v1/tags", "access", "tag.read", 5),
  route("POST", "/api/v1/tags", "access", "tag.create", 5),
  route("PATCH", "/api/v1/tags/:tagId", "access", "tag.update", 5),
  route("DELETE", "/api/v1/tags/:tagId", "access", "tag.delete", 5),
  route("POST", "/api/v1/content-session", "access", "content.session.create", 6),
  route("DELETE", "/api/v1/tickets/:ticketId", "access", "ticket.cancel", 6),
  route("GET", "/api/v1/app-passwords", "access", "credential.read", 1),
  route("POST", "/api/v1/app-passwords", "access", "credential.create", 1),
  route("DELETE", "/api/v1/app-passwords/:credentialId", "access", "credential.revoke", 1),
  route("GET", "/api/v1/jobs/:jobId", "access", "job.read", 1),
  route("POST", "/api/v1/jobs/:jobId/cancel", "access", "job.cancel", 1),
  route("POST", "/api/v1/jobs/:jobId/retry", "access", "job.retry", 1),
  route("GET", "/api/v1/admin/dlq", "access", "admin.dlq", 1, "same-origin-json", "app", true),
  route("POST", "/api/v1/admin/dlq/:jobId/requeue", "access", "admin.dlq", 1, "same-origin-json", "app", true),
  route("POST", "/api/v1/admin/users/:userId/disable", "access", "admin.user.disable", 1, "same-origin-json", "app", true),
  route("POST", "/api/v1/admin/transfer", "access", "admin.transfer", 1, "same-origin-json", "app", true),
  route("POST", "/api/v1/admin/locks/:lockId/force-unlock", "access", "admin.lock.force_unlock", 1, "same-origin-json", "app", true),
  route("GET", "/api/v1/automation/nodes", "service", "automation.list", 1),
  route("GET", "/api/v1/automation/nodes/:nodeId", "service", "automation.metadata.read", 1),
  route("GET", "/api/v1/public/shares/:shareId", "share", "share.read", 6),
  route("GET", "/api/v1/public/shares/:shareId/children/:nodeId", "share", "share.read", 6),
  route("GET", "/api/v1/public/shares/:shareId/content/:nodeId", "share", "share.read", 6),
  route("HEAD", "/api/v1/public/shares/:shareId/content/:nodeId", "share", "share.read", 6),
  route("GET", "/api/v1/public/shares/:shareId/thumb/:nodeId", "share", "share.read", 8),
  route("HEAD", "/api/v1/public/shares/:shareId/thumb/:nodeId", "share", "share.read", 8),
  route("POST", "/api/v1/public/shares/:shareId/csrf", "share", "csrf.issue", 6, "public-csrf-issue"),
  route("POST", "/api/v1/public/shares/:shareId/unlock", "public", "share.unlock", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/logout", "share", "share.logout", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/tickets", "share", "share.read", 6, "public-form"),
  route("DELETE", "/api/v1/public/shares/:shareId/tickets/:ticketId", "share", "ticket.cancel", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/content-session", "share", "content.session.create", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/nodes/:nodeId/zip", "share", "zip.create", 6, "public-form"),
  route("GET", "/api/v1/public/shares/:shareId/zips/:zipId", "share", "zip.read", 6, "public-form"),
  route("GET", "/api/v1/public/shares/:shareId/gallery", "share", "gallery.read", 8),
  route("GET", "/api/v1/public/shares/:shareId/tracks", "share", "audio.read", 8),
  route(
    "GET",
    "/api/v1/public/shares/:shareId/audio/:nodeId/cover",
    "share",
    "audio.read",
    8,
  ),
  route(
    "HEAD",
    "/api/v1/public/shares/:shareId/audio/:nodeId/cover",
    "share",
    "audio.read",
    8,
  ),
  route("GET", "/api/v1/public/shares/:shareId/library/:nodeId", "share", "library.read", 8),
  route("GET", "/api/v1/public/shares/:shareId/library/:nodeId/pages/:page", "share", "library.read", 8),
  route("HEAD", "/api/v1/public/shares/:shareId/library/:nodeId/pages/:page", "share", "library.read", 8),
  route("GET", "/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken", "share", "library.read", 8),
  route("HEAD", "/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken", "share", "library.read", 8),
  route("POST", "/api/v1/public/shares/:shareId/nodes", "share", "node.create", 6, "public-form"),
  route("PATCH", "/api/v1/public/shares/:shareId/nodes/:nodeId", "share", "node.rename", 6, "public-form"),
  route("DELETE", "/api/v1/public/shares/:shareId/nodes/:nodeId", "share", "node.trash", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/uploads", "share", "upload.create", 6, "public-form"),
  route("GET", "/api/v1/public/shares/:shareId/uploads/:uploadId", "share", "upload.read", 6, "public-form"),
  route("PUT", "/api/v1/public/shares/:shareId/uploads/:uploadId/content", "share", "upload.write", 6, "public-form"),
  route("PUT", "/api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber", "share", "upload.write", 6, "public-form"),
  route("POST", "/api/v1/public/shares/:shareId/uploads/:uploadId/complete", "share", "upload.complete", 6, "public-form"),
  route("DELETE", "/api/v1/public/shares/:shareId/uploads/:uploadId", "share", "upload.abort", 6, "public-form"),
  route("OPTIONS", "/dav", "app_password", "dav.options", 7, "dav"),
  route("PROPFIND", "/dav", "app_password", "dav.propfind", 7, "dav"),
  route("PROPPATCH", "/dav", "app_password", "dav.proppatch", 7, "dav"),
  route("MKCOL", "/dav", "app_password", "dav.mkcol", 7, "dav"),
  route("GET", "/dav", "app_password", "dav.read", 7, "dav"),
  route("HEAD", "/dav", "app_password", "dav.read", 7, "dav"),
  route("PUT", "/dav", "app_password", "dav.put", 7, "dav"),
  route("DELETE", "/dav", "app_password", "dav.delete", 7, "dav"),
  route("COPY", "/dav", "app_password", "dav.copy", 7, "dav"),
  route("MOVE", "/dav", "app_password", "dav.move", 7, "dav"),
  route("LOCK", "/dav", "app_password", "dav.lock", 7, "dav"),
  route("UNLOCK", "/dav", "app_password", "dav.unlock", 7, "dav"),
  route("OPTIONS", "/dav/*", "app_password", "dav.options", 7, "dav"),
  route("PROPFIND", "/dav/*", "app_password", "dav.propfind", 7, "dav"),
  route("PROPPATCH", "/dav/*", "app_password", "dav.proppatch", 7, "dav"),
  route("MKCOL", "/dav/*", "app_password", "dav.mkcol", 7, "dav"),
  route("GET", "/dav/*", "app_password", "dav.read", 7, "dav"),
  route("HEAD", "/dav/*", "app_password", "dav.read", 7, "dav"),
  route("PUT", "/dav/*", "app_password", "dav.put", 7, "dav"),
  route("DELETE", "/dav/*", "app_password", "dav.delete", 7, "dav"),
  route("COPY", "/dav/*", "app_password", "dav.copy", 7, "dav"),
  route("MOVE", "/dav/*", "app_password", "dav.move", 7, "dav"),
  route("LOCK", "/dav/*", "app_password", "dav.lock", 7, "dav"),
  route("UNLOCK", "/dav/*", "app_password", "dav.unlock", 7, "dav"),
  route("OPTIONS", "/session", "public", "content.session.accept", 6, "cross-origin-content", "content"),
  route("POST", "/session", "public", "content.session.accept", 6, "cross-origin-content", "content"),
  route("GET", "/c/:nodeId/:blobId", "content_cookie", "content.read", 6, "cross-origin-content", "content"),
  route("HEAD", "/c/:nodeId/:blobId", "content_cookie", "content.read", 6, "same-origin-json", "content"),
  route("GET", "/c/:nodeId/:blobId/pages/:page", "content_cookie", "content.read", 8, "same-origin-json", "content"),
  route("HEAD", "/c/:nodeId/:blobId/pages/:page", "content_cookie", "content.read", 8, "same-origin-json", "content"),
  route("GET", "/c/:nodeId/:blobId/entries/:entryToken", "content_cookie", "content.read", 8, "same-origin-json", "content"),
  route("HEAD", "/c/:nodeId/:blobId/entries/:entryToken", "content_cookie", "content.read", 8, "same-origin-json", "content"),
  route("GET", "/reader/index.html", "public", "reader.shell", 8, "same-origin-json", "content"),
  route("GET", "/reader/:asset", "public", "reader.shell", 8, "same-origin-json", "content"),
  route("GET", "/reader-assets/:asset", "public", "reader.shell", 8, "same-origin-json", "content"),
] satisfies readonly RouteDefinition[];

export function routeKey(routeDefinition: Pick<RouteDefinition, "method" | "template">): string {
  return `${routeDefinition.method} ${routeDefinition.template}`;
}

export const phaseOneRoutes = routeManifest.filter((definition) => definition.phase === 1);

export function routesThroughPhase(phase: RouteDefinition["phase"]): readonly RouteDefinition[] {
  return routeManifest.filter((definition) => definition.phase <= phase);
}
