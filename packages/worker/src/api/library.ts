import type { ReadingPosition } from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare } from "../auth/share.js";
import { discoverLibraryJobs, dispatchPendingLibraryJobs } from "../jobs/library.js";
import {
  addLibraryRoot,
  getLibraryItem,
  listLibraryItems,
  listLibraryRoots,
  removeLibraryRoot,
  saveReadingState,
  serveEpubEntry,
  serveLibraryCover,
  serveLibraryPage,
  updateLibraryItem,
} from "../services/library.js";
import { acquireBudget, attachBudgetLease } from "../services/budgets.js";
import { assertShareNode } from "../services/shares.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function requireScope(scopes: readonly string[], scope: "library:read" | "library:write"): void {
  if (!scopes.includes(scope)) throw new Error("library_scope_forbidden");
}

export async function handleLibraryItems(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return context.json({ items: await listLibraryItems(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLibraryItem(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return context.json(
      await getLibraryItem(context.env, user.principal.userId, context.req.param("itemId")),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleUpdateLibraryItem(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:write");
    const body = await context.req.json<{
      title?: unknown;
      author?: unknown;
      series?: unknown;
      tags?: unknown;
    }>();
    if (
      (body.title !== undefined && typeof body.title !== "string") ||
      (body.author !== undefined && typeof body.author !== "string") ||
      (body.series !== undefined && typeof body.series !== "string") ||
      (body.tags !== undefined &&
        (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string")))
    ) {
      throw new RangeError("Library metadata is invalid");
    }
    await updateLibraryItem(context.env, user.principal.userId, context.req.param("itemId"), {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.author === "string" ? { author: body.author } : {}),
      ...(typeof body.series === "string" ? { series: body.series } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags } : {}),
    });
    return context.json(
      await getLibraryItem(context.env, user.principal.userId, context.req.param("itemId")),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLibraryPage(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return await serveLibraryPage(
      context.env,
      user.principal.userId,
      context.req.param("itemId"),
      Number(context.req.param("page")),
      context.req.method === "HEAD",
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLibraryCover(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return await serveLibraryCover(
      context.env,
      user.principal.userId,
      context.req.param("itemId"),
      context.req.method === "HEAD",
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleEpubEntry(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return await serveEpubEntry(
      context.env,
      user.principal.userId,
      context.req.param("itemId"),
      context.req.param("entryId"),
      context.req.method === "HEAD",
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleReadingState(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:write");
    const body = await context.req.json<Partial<ReadingPosition>>();
    if (
      typeof body.page !== "number" ||
      (body.mode !== "single" && body.mode !== "spread") ||
      typeof body.rtl !== "boolean"
    ) {
      throw new RangeError("Reading position is invalid");
    }
    await saveReadingState(context.env, user.principal.userId, context.req.param("itemId"), {
      page: body.page,
      mode: body.mode,
      rtl: body.rtl,
      ...(typeof body.entryId === "string" ? { entryId: body.entryId } : {}),
      ...(typeof body.cfi === "string" ? { cfi: body.cfi } : {}),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLibraryRoots(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:read");
    return context.json({ items: await listLibraryRoots(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleAddLibraryRoot(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:write");
    const body = await context.req.json<{ nodeId?: unknown }>();
    if (typeof body.nodeId !== "string") throw new RangeError("Library root is required");
    await addLibraryRoot(context.env, user.principal.userId, body.nodeId);
    await discoverLibraryJobs(context.env);
    await dispatchPendingLibraryJobs(context.env);
    return context.json({ items: await listLibraryRoots(context.env, user.principal.userId) }, 201);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleRemoveLibraryRoot(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    requireScope(user.principal.scopes, "library:write");
    await removeLibraryRoot(context.env, user.principal.userId, context.req.param("nodeId"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

async function publicLibraryItemId(
  context: AppContext,
  ownerId: string,
  nodeId: string,
): Promise<string> {
  const row = await context.env.DB.prepare(
    "SELECT i.id FROM library_items i JOIN nodes n ON n.id=i.node_id WHERE n.id=?1 AND n.owner_id=?2 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL AND i.status='indexed'",
  )
    .bind(nodeId, ownerId)
    .first<{ id: string }>();
  if (row === null) throw new Error("node_not_found");
  return row.id;
}

export async function handlePublicLibraryItem(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "read");
    const itemId = await publicLibraryItemId(context, authentication.share.ownerId, nodeId);
    const result = await getLibraryItem(context.env, authentication.share.ownerId, itemId);
    return context.json({ ...result, item: { ...result.item, coverUrl: null } });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicLibraryPage(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "read");
    const itemId = await publicLibraryItemId(context, authentication.share.ownerId, nodeId);
    const response = await serveLibraryPage(
      context.env,
      authentication.share.ownerId,
      itemId,
      Number(context.req.param("page")),
      context.req.method === "HEAD",
    );
    const bytes =
      context.req.method === "HEAD" ? 0 : Number(response.headers.get("Content-Length") ?? 0);
    const lease = await acquireBudget(
      context.env,
      authentication.budgetId,
      authentication.budgetMaxBytes,
      bytes,
    );
    return await attachBudgetLease(response, lease);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicEpubEntry(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "read");
    const itemId = await publicLibraryItemId(context, authentication.share.ownerId, nodeId);
    const response = await serveEpubEntry(
      context.env,
      authentication.share.ownerId,
      itemId,
      context.req.param("entryToken"),
      context.req.method === "HEAD",
    );
    const bytes =
      context.req.method === "HEAD" ? 0 : Number(response.headers.get("Content-Length") ?? 0);
    const lease = await acquireBudget(
      context.env,
      authentication.budgetId,
      authentication.budgetMaxBytes,
      bytes,
    );
    return await attachBudgetLease(response, lease);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleReaderShell(context: AppContext): Promise<Response> {
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/reader.html`, context.req.raw),
  );
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  const appOrigin = new URL(context.env.APP_ORIGIN).origin;
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors ${appOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'`,
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export async function handleReaderAsset(context: AppContext): Promise<Response> {
  const asset = context.req.param("asset");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(asset)) {
    return jsonError(context, 404, "not_found", "Asset not found");
  }
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/reader-assets/${asset}`, context.req.raw),
  );
  if (!response.ok) return jsonError(context, 404, "not_found", "Asset not found");
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
