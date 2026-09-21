import { createShareBodySchema, unlockShareBodySchema, updateShareBodySchema } from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare, issueShareCsrf, logoutShare, unlockShare } from "../auth/share.js";
import { acquireBudget, attachBudgetLease } from "../services/budgets.js";
import { getContentDescriptor, serveNodeContentById } from "../services/content.js";
import {
  assertShareNode,
  createShare,
  disableShare,
  getShare,
  getShareNode,
  listShareChildren,
  listSharedWithMe,
  listShares,
  updateShare,
} from "../services/shares.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function publicFormOrigin(context: AppContext): boolean {
  return (
    context.req.header("Origin") === context.env.APP_ORIGIN &&
    context.req.header("Sec-Fetch-Site") === "same-origin"
  );
}

export async function handleListShares(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({ items: await listShares(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreateShare(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = createShareBodySchema.parse(await context.req.json());
    return context.json(
      await createShare(context.env, user, {
        rootNodeId: body.rootNodeId,
        kind: body.kind,
        mode: body.mode,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        ...(body.password === undefined ? {} : { password: body.password }),
        ...(body.granteeEmail === undefined ? {} : { granteeEmail: body.granteeEmail }),
      }),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleGetShare(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await getShare(context.env, user.principal.userId, context.req.param("shareId")),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleUpdateShare(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = updateShareBodySchema.parse(await context.req.json());
    return context.json(
      await updateShare(context.env, user, context.req.param("shareId"), {
        ...(body.mode === undefined ? {} : { mode: body.mode }),
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        ...(body.password === undefined ? {} : { password: body.password }),
      }),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleDisableShare(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    await disableShare(context.env, user, context.req.param("shareId"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleSharedWithMe(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({ items: await listSharedWithMe(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleShareLanding(context: AppContext): Promise<Response> {
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/public-share.html`, context.req.raw),
  );
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export async function handlePublicAsset(context: AppContext): Promise<Response> {
  const asset = context.req.param("asset");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(asset)) {
    return jsonError(context, 404, "not_found", "Asset not found");
  }
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/public-assets/${asset}`, context.req.raw),
  );
  if (!response.ok) return jsonError(context, 404, "not_found", "Asset not found");
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export async function handleUnlockShare(context: AppContext): Promise<Response> {
  try {
    if (!publicFormOrigin(context)) throw new Error("csrf_failed");
    const body = unlockShareBodySchema.parse(await context.req.json());
    const result = await unlockShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
      body.secret,
      body.password,
    );
    return context.json(
      {
        shareId: result.authentication.share.id,
        mode: result.authentication.share.mode,
        expiresAt: result.authentication.share.expiresAt,
      },
      200,
      { "Set-Cookie": result.cookie, "Cache-Control": "private, no-store" },
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicCsrf(context: AppContext): Promise<Response> {
  try {
    if (!publicFormOrigin(context)) throw new Error("csrf_failed");
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json({
      token: await issueShareCsrf(context.env, authentication.sessionId),
      expiresIn: 3600,
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLogoutShare(context: AppContext): Promise<Response> {
  try {
    const cookie = await logoutShare(context.env, context.req.raw, context.req.param("shareId"));
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie } });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicShare(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json({
      id: authentication.share.id,
      mode: authentication.share.mode,
      expiresAt: authentication.share.expiresAt,
      root:
        authentication.share.mode === "upload"
          ? null
          : await getShareNode(context.env, authentication.share, authentication.share.rootNodeId),
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicChildren(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json({
      items: await listShareChildren(
        context.env,
        authentication.share,
        context.req.param("nodeId"),
      ),
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicContent(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "download");
    const descriptor = await getContentDescriptor(context.env, nodeId);
    const lease = await acquireBudget(
      context.env,
      authentication.budgetId,
      authentication.budgetMaxBytes,
      context.req.method === "HEAD" ? 0 : descriptor.size,
    );
    try {
      return await attachBudgetLease(
        await serveNodeContentById(context.env, nodeId, context.req.raw),
        lease,
      );
    } catch (error) {
      await lease.settle().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return mapError(context, error);
  }
}
