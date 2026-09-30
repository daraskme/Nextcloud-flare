import type { AuthMode, CsrfProfile, RouteContract } from "@next-cloud-flare/shared/contracts";

export type RouteHandler =
  | "private-app"
  | "public-share"
  | "private-assets"
  | "dav"
  | "content"
  | "unavailable";
export type RouteCacheProfile = "private-no-store" | "public-immutable";
export type RouteFallbackPolicy = "none" | "private-spa-exact";
export type AssetNamespace = "private" | "public" | "reader";

export interface RouteBinding {
  readonly key: string;
  readonly host: RouteContract["host"];
  readonly auth: readonly AuthMode[];
  readonly adminOnly: boolean;
  readonly csrf: CsrfProfile;
  readonly availability: "bound" | "unavailable";
  readonly handler: RouteHandler;
  readonly cache: RouteCacheProfile;
  readonly fallback: RouteFallbackPolicy;
  readonly assetNamespace?: AssetNamespace;
}

interface BindingProfile {
  readonly host: RouteContract["host"];
  readonly auth: readonly AuthMode[];
  readonly adminOnly: boolean;
  readonly csrf: CsrfProfile;
}

const appAccess = {
  host: "app",
  auth: ["access"],
  adminOnly: false,
  csrf: "same-origin-json",
} as const satisfies BindingProfile;
const appAccessCsrf = {
  ...appAccess,
  csrf: "csrf-issue",
} as const satisfies BindingProfile;
const appOperation = {
  ...appAccess,
  auth: ["access", "app_password", "share"],
} as const satisfies BindingProfile;
const appAdmin = {
  ...appAccess,
  adminOnly: true,
} as const satisfies BindingProfile;
const appService = {
  ...appAccess,
  auth: ["service"],
} as const satisfies BindingProfile;
const appPublic = {
  ...appAccess,
  auth: ["public"],
} as const satisfies BindingProfile;
const appShare = {
  ...appAccess,
  auth: ["share"],
} as const satisfies BindingProfile;
const appPublicForm = {
  ...appPublic,
  csrf: "public-form",
} as const satisfies BindingProfile;
const appShareForm = {
  ...appShare,
  csrf: "public-form",
} as const satisfies BindingProfile;
const appShareCsrf = {
  ...appShare,
  csrf: "public-csrf-issue",
} as const satisfies BindingProfile;
const appDav = {
  ...appAccess,
  auth: ["app_password"],
  csrf: "dav",
} as const satisfies BindingProfile;
const contentPublic = {
  ...appPublic,
  host: "content",
} as const satisfies BindingProfile;
const contentPublicCrossOrigin = {
  ...contentPublic,
  csrf: "cross-origin-content",
} as const satisfies BindingProfile;
const contentCookie = {
  ...appAccess,
  host: "content",
  auth: ["content_cookie"],
} as const satisfies BindingProfile;
const contentCookieCrossOrigin = {
  ...contentCookie,
  csrf: "cross-origin-content",
} as const satisfies BindingProfile;

function bindings(
  profile: BindingProfile,
  availability: RouteBinding["availability"],
  handler: RouteHandler,
  keys: readonly string[],
  options: {
    readonly cache?: RouteCacheProfile;
    readonly fallback?: RouteFallbackPolicy;
    readonly assetNamespace?: AssetNamespace;
  } = {},
): RouteBinding[] {
  return keys.map((key) => ({
    key,
    ...profile,
    availability,
    handler,
    cache: options.cache ?? "private-no-store",
    fallback: options.fallback ?? "none",
    ...(options.assetNamespace ? { assetNamespace: options.assetNamespace } : {}),
  }));
}

export const ROUTE_BINDINGS = [
  ...bindings(appAccess, "bound", "private-assets", ["app GET /"], {
    fallback: "private-spa-exact",
  }),
  ...bindings(appAccess, "bound", "private-assets", ["app GET /private-assets/:asset"], {
    assetNamespace: "private",
  }),
  ...bindings(appPublic, "bound", "public-share", ["app GET /public-assets/:asset"], {
    assetNamespace: "public",
    cache: "public-immutable",
  }),
  ...bindings(appPublic, "bound", "public-share", ["app GET /s", "app GET /s/:shareId"]),
  ...bindings(appAccess, "bound", "private-app", [
    "app GET /api/v1/me",
    "app POST /api/v1/auth/logout",
    "app GET /api/v1/search",
    "app GET /api/v1/stats",
    "app GET /api/v1/nodes/:nodeId",
    "app GET /api/v1/nodes/:nodeId/path",
    "app GET /api/v1/nodes/:nodeId/children",
    "app GET /api/v1/nodes/:nodeId/gallery",
    "app GET /api/v1/nodes/:nodeId/tracks",
    "app POST /api/v1/nodes",
    "app PATCH /api/v1/nodes/:nodeId",
    "app DELETE /api/v1/nodes/:nodeId",
    "app POST /api/v1/nodes/:nodeId/move",
    "app POST /api/v1/nodes/:nodeId/copy",
    "app POST /api/v1/uploads",
    "app GET /api/v1/uploads/:uploadId",
    "app PUT /api/v1/uploads/:uploadId/content",
    "app PUT /api/v1/uploads/:uploadId/parts/:partNumber",
    "app POST /api/v1/uploads/:uploadId/complete",
    "app DELETE /api/v1/uploads/:uploadId",
    "app GET /api/v1/trash",
    "app POST /api/v1/trash/:opId/restore",
    "app POST /api/v1/trash/:opId/purge",
    "app POST /api/v1/content-session",
    "app DELETE /api/v1/tickets/:ticketId",
    "app GET /api/v1/app-passwords",
    "app POST /api/v1/app-passwords",
    "app DELETE /api/v1/app-passwords/:credentialId",
    "app GET /api/v1/shares",
    "app POST /api/v1/shares",
    "app GET /api/v1/shares/:shareId",
    "app DELETE /api/v1/shares/:shareId",
  ]),
  ...bindings(appAccessCsrf, "bound", "private-app", ["app POST /api/v1/csrf"]),
  ...bindings(appOperation, "bound", "private-app", ["app GET /api/v1/operations/:id"]),
  ...bindings(appShare, "bound", "public-share", [
    "app GET /api/v1/public/shares/:shareId",
    "app GET /api/v1/public/shares/:shareId/children/:nodeId",
  ]),
  ...bindings(appPublicForm, "bound", "public-share", [
    "app POST /api/v1/public/shares/:shareId/unlock",
  ]),
  ...bindings(appShareForm, "bound", "public-share", [
    "app POST /api/v1/public/shares/:shareId/logout",
    "app POST /api/v1/public/shares/:shareId/tickets",
    "app DELETE /api/v1/public/shares/:shareId/tickets/:ticketId",
    "app POST /api/v1/public/shares/:shareId/content-session",
  ]),
  ...bindings(appShareCsrf, "bound", "public-share", [
    "app POST /api/v1/public/shares/:shareId/csrf",
  ]),
  ...bindings(appAccess, "unavailable", "unavailable", [
    "app GET /api/v1/recent",
    "app GET /api/v1/starred",
    "app GET /api/v1/nodes/:nodeId/content",
    "app HEAD /api/v1/nodes/:nodeId/content",
    "app GET /api/v1/nodes/:nodeId/thumb",
    "app HEAD /api/v1/nodes/:nodeId/thumb",
    "app GET /api/v1/nodes/:nodeId/preview",
    "app HEAD /api/v1/nodes/:nodeId/preview",
    "app PUT /api/v1/nodes/:nodeId/content",
    "app PUT /api/v1/nodes/:nodeId/star",
    "app POST /api/v1/nodes/:nodeId/zip",
    "app GET /api/v1/zips/:id",
    "app PATCH /api/v1/nodes/:nodeId/audio",
    "app PUT /api/v1/nodes/:nodeId/playback-state",
    "app GET /api/v1/library/items",
    "app GET /api/v1/library/items/:itemId",
    "app PATCH /api/v1/library/items/:itemId",
    "app GET /api/v1/library/:nodeId",
    "app GET /api/v1/library/:nodeId/pages/:page",
    "app HEAD /api/v1/library/:nodeId/pages/:page",
    "app GET /api/v1/library/:nodeId/pages/:page/thumb",
    "app HEAD /api/v1/library/:nodeId/pages/:page/thumb",
    "app GET /api/v1/library/:nodeId/entries/:entryToken",
    "app HEAD /api/v1/library/:nodeId/entries/:entryToken",
    "app PUT /api/v1/library/:nodeId/reading-state",
    "app GET /api/v1/library/roots",
    "app POST /api/v1/library/roots",
    "app DELETE /api/v1/library/roots/:nodeId",
    "app GET /api/v1/tags",
    "app POST /api/v1/tags",
    "app PATCH /api/v1/tags/:tagId",
    "app DELETE /api/v1/tags/:tagId",
    "app GET /api/v1/jobs/:jobId",
    "app POST /api/v1/jobs/:jobId/cancel",
    "app POST /api/v1/jobs/:jobId/retry",
  ]),
  ...bindings(appAccess, "bound", "private-app", ["app GET /api/v1/shared-with-me"]),
  ...bindings(appAccess, "bound", "private-app", ["app PATCH /api/v1/shares/:shareId"]),
  ...bindings(appAdmin, "unavailable", "unavailable", [
    "app GET /api/v1/admin/dlq",
    "app POST /api/v1/admin/dlq/:jobId/requeue",
    "app POST /api/v1/admin/users/:userId/disable",
    "app POST /api/v1/admin/transfer",
    "app POST /api/v1/admin/locks/:lockId/force-unlock",
  ]),
  ...bindings(appService, "unavailable", "unavailable", [
    "app GET /api/v1/automation/nodes",
    "app GET /api/v1/automation/nodes/:nodeId",
  ]),
  ...bindings(appShare, "unavailable", "unavailable", [
    "app GET /api/v1/public/shares/:shareId/content/:nodeId",
    "app HEAD /api/v1/public/shares/:shareId/content/:nodeId",
    "app GET /api/v1/public/shares/:shareId/thumb/:nodeId",
    "app HEAD /api/v1/public/shares/:shareId/thumb/:nodeId",
    "app GET /api/v1/public/shares/:shareId/gallery",
    "app GET /api/v1/public/shares/:shareId/tracks",
    "app GET /api/v1/public/shares/:shareId/library/:nodeId",
    "app GET /api/v1/public/shares/:shareId/library/:nodeId/pages/:page",
    "app HEAD /api/v1/public/shares/:shareId/library/:nodeId/pages/:page",
    "app GET /api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken",
    "app HEAD /api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken",
  ]),
  ...bindings(appShareForm, "unavailable", "unavailable", [
    "app POST /api/v1/public/shares/:shareId/nodes/:nodeId/zip",
    "app GET /api/v1/public/shares/:shareId/zips/:zipId",
    "app POST /api/v1/public/shares/:shareId/nodes",
    "app PATCH /api/v1/public/shares/:shareId/nodes/:nodeId",
    "app DELETE /api/v1/public/shares/:shareId/nodes/:nodeId",
  ]),
  ...bindings(appShareForm, "bound", "public-share", [
    "app POST /api/v1/public/shares/:shareId/uploads",
    "app GET /api/v1/public/shares/:shareId/uploads/:uploadId",
    "app PUT /api/v1/public/shares/:shareId/uploads/:uploadId/content",
    "app PUT /api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber",
    "app POST /api/v1/public/shares/:shareId/uploads/:uploadId/complete",
    "app DELETE /api/v1/public/shares/:shareId/uploads/:uploadId",
  ]),
  ...bindings(appDav, "bound", "dav", [
    "app OPTIONS /dav",
    "app OPTIONS /dav/*path",
    "app PROPFIND /dav",
    "app PROPFIND /dav/*path",
    "app PROPPATCH /dav",
    "app PROPPATCH /dav/*path",
    "app MKCOL /dav",
    "app MKCOL /dav/*path",
    "app GET /dav",
    "app GET /dav/*path",
    "app HEAD /dav",
    "app HEAD /dav/*path",
    "app PUT /dav",
    "app PUT /dav/*path",
    "app DELETE /dav",
    "app DELETE /dav/*path",
    "app COPY /dav",
    "app COPY /dav/*path",
    "app MOVE /dav",
    "app MOVE /dav/*path",
    "app LOCK /dav",
    "app LOCK /dav/*path",
    "app UNLOCK /dav",
    "app UNLOCK /dav/*path",
  ]),
  ...bindings(contentPublicCrossOrigin, "bound", "content", [
    "content OPTIONS /session",
    "content POST /session",
  ]),
  ...bindings(contentCookieCrossOrigin, "bound", "content", ["content GET /c/:nodeId/:blobId"]),
  ...bindings(contentCookie, "bound", "content", ["content HEAD /c/:nodeId/:blobId"]),
  ...bindings(contentCookieCrossOrigin, "bound", "content", [
    "content GET /c/:nodeId/:blobId/thumb",
  ]),
  ...bindings(contentCookie, "bound", "content", ["content HEAD /c/:nodeId/:blobId/thumb"]),
  ...bindings(contentCookieCrossOrigin, "bound", "content", ["content GET /z/:targetSetId"]),
  ...bindings(contentCookie, "bound", "content", ["content HEAD /z/:targetSetId"]),
  ...bindings(contentCookie, "unavailable", "unavailable", [
    "content GET /c/:nodeId/:blobId/pages/:page",
    "content HEAD /c/:nodeId/:blobId/pages/:page",
    "content GET /c/:nodeId/:blobId/entries/:entryToken",
    "content HEAD /c/:nodeId/:blobId/entries/:entryToken",
  ]),
  ...bindings(contentPublic, "unavailable", "unavailable", ["content GET /reader/index.html"]),
  ...bindings(contentPublic, "unavailable", "unavailable", ["content GET /reader-assets/:asset"], {
    assetNamespace: "reader",
    cache: "public-immutable",
  }),
] as const satisfies readonly RouteBinding[];

export const PRIVATE_SPA_PATHS = ["/", "/files", "/gallery", "/audio", "/trash"] as const;
const PRIVATE_FILE_PATH = /^\/files\/[A-Za-z0-9_-]{1,128}$/;

export function privateSpaPath(path: string): boolean {
  return (
    PRIVATE_SPA_PATHS.includes(path as (typeof PRIVATE_SPA_PATHS)[number]) ||
    PRIVATE_FILE_PATH.test(path)
  );
}

export function routeContractKey(
  route: Pick<RouteContract, "host" | "method" | "template">,
): string {
  return `${route.host} ${route.method} ${route.template}`;
}

function sameAuth(left: readonly AuthMode[], right: readonly AuthMode[]): boolean {
  return left.length === right.length && left.every((mode, index) => mode === right[index]);
}

export function verifyRouteBindings(
  routes: readonly RouteContract[],
  routeBindings: readonly RouteBinding[],
): string[] {
  const errors: string[] = [];
  const contracts = new Map<string, RouteContract>();
  for (const route of routes) {
    const key = routeContractKey(route);
    if (contracts.has(key)) errors.push(`duplicate contract: ${key}`);
    contracts.set(key, route);
  }
  const bindingsByKey = new Map<string, RouteBinding>();
  for (const binding of routeBindings) {
    if (bindingsByKey.has(binding.key)) errors.push(`duplicate binding: ${binding.key}`);
    bindingsByKey.set(binding.key, binding);
    const route = contracts.get(binding.key);
    if (!route) {
      errors.push(`unknown binding: ${binding.key}`);
      continue;
    }
    if (binding.host !== route.host) errors.push(`host mismatch: ${binding.key}`);
    if (!sameAuth(binding.auth, route.auth)) errors.push(`auth mismatch: ${binding.key}`);
    if (binding.adminOnly !== route.adminOnly) errors.push(`adminOnly mismatch: ${binding.key}`);
    if (binding.csrf !== route.csrf) errors.push(`csrf mismatch: ${binding.key}`);
    if (binding.availability === "bound" && binding.handler === "unavailable")
      errors.push(`bound route lacks handler: ${binding.key}`);
    if (binding.availability === "unavailable" && binding.handler !== "unavailable")
      errors.push(`unavailable route has handler: ${binding.key}`);
    const expectedAssetNamespace = route.template.startsWith("/private-assets/")
      ? "private"
      : route.template.startsWith("/public-assets/")
        ? "public"
        : route.template.startsWith("/reader-assets/")
          ? "reader"
          : undefined;
    if (binding.assetNamespace !== expectedAssetNamespace)
      errors.push(`asset namespace mismatch: ${binding.key}`);
    const expectedCache =
      expectedAssetNamespace === "public" || expectedAssetNamespace === "reader"
        ? "public-immutable"
        : "private-no-store";
    if (binding.cache !== expectedCache) errors.push(`cache mismatch: ${binding.key}`);
    const expectedFallback = binding.key === "app GET /" ? "private-spa-exact" : "none";
    if (binding.fallback !== expectedFallback) errors.push(`fallback mismatch: ${binding.key}`);
  }
  for (const key of contracts.keys()) {
    if (!bindingsByKey.has(key)) errors.push(`missing binding: ${key}`);
  }
  return errors;
}
