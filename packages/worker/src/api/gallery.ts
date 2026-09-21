import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare } from "../auth/share.js";
import { serveThumbnail } from "../media/images/derivatives.js";
import { acquireBudget, attachBudgetLease } from "../services/budgets.js";
import { listGallery } from "../services/gallery.js";
import { assertShareNode } from "../services/shares.js";
import { type AppContext, jsonError, mapError } from "./http.js";

export async function handleGallery(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    if (!user.principal.scopes.includes("library:read")) {
      return jsonError(context, 403, "forbidden", "Gallery access is not allowed");
    }
    const recursiveValue = context.req.query("recursive") ?? "false";
    if (recursiveValue !== "true" && recursiveValue !== "false") {
      throw new RangeError("recursive must be true or false");
    }
    const limitValue = context.req.query("limit");
    const cursor = context.req.query("cursor");
    return context.json(
      await listGallery(context.env, {
        userId: user.principal.userId,
        rootId: context.req.param("nodeId"),
        recursive: recursiveValue === "true",
        ...(cursor === undefined ? {} : { cursor }),
        ...(limitValue === undefined ? {} : { limit: Number(limitValue) }),
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "gallery_scope_too_large") {
      return jsonError(
        context,
        413,
        "gallery_scope_too_large",
        "Gallery scope exceeds 50,000 nodes",
      );
    }
    return mapError(context, error);
  }
}

export async function handlePublicGallery(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    if (!authentication.principal.scopes.includes("node:read")) {
      return jsonError(context, 403, "forbidden", "Gallery access is not allowed");
    }
    const recursiveValue = context.req.query("recursive") ?? "true";
    if (recursiveValue !== "true" && recursiveValue !== "false") {
      throw new RangeError("recursive must be true or false");
    }
    const cursor = context.req.query("cursor");
    const page = await listGallery(context.env, {
      userId: authentication.share.ownerId,
      rootId: authentication.share.rootNodeId,
      recursive: recursiveValue === "true",
      ...(cursor === undefined ? {} : { cursor }),
    });
    return context.json({
      ...page,
      items: page.items.map((item) => ({
        ...item,
        thumbUrl: `/api/v1/public/shares/${encodeURIComponent(authentication.share.id)}/thumb/${encodeURIComponent(item.id)}`,
        contentUrl: `/api/v1/public/shares/${encodeURIComponent(authentication.share.id)}/content/${encodeURIComponent(item.id)}`,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "gallery_scope_too_large") {
      return jsonError(
        context,
        413,
        "gallery_scope_too_large",
        "Gallery scope exceeds 50,000 nodes",
      );
    }
    return mapError(context, error);
  }
}

export async function handleThumbnail(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const route = new URL(context.req.url).pathname;
    const requested =
      context.req.query("variant") ?? (route.endsWith("/preview") ? "lg1600" : "md768");
    if (requested !== "sm256" && requested !== "md768" && requested !== "lg1600") {
      throw new RangeError("Thumbnail variant is invalid");
    }
    return await serveThumbnail(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
      requested,
      context.req.method === "HEAD",
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicThumbnail(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "read");
    const response = await serveThumbnail(
      context.env,
      authentication.share.ownerId,
      nodeId,
      "md768",
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
