import { authenticateAccessUser } from "../auth/httpAuth.js";
import { getOwnerWorkspace } from "../services/nodes.js";
import { searchNodes } from "../services/search.js";
import { getAccountStats, listRecent, listStarred, setStar } from "../services/stats.js";
import { type AppContext, mapError } from "./http.js";

export async function handleSearch(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const query = context.req.query("q") ?? "";
    const root = context.req.query("root") ?? workspace.rootId;
    return context.json(await searchNodes(context.env, user.principal.userId, root, query));
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleStats(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(await getAccountStats(context.env, user.principal.userId));
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleRecent(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({ items: await listRecent(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleStarred(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({ items: await listStarred(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleSetStar(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body: { starred?: unknown } = await context.req.json();
    await setStar(
      context.env,
      user.principal.userId,
      user.principal.sessionId,
      context.req.param("nodeId"),
      body.starred !== false,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
