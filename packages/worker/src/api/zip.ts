import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare } from "../auth/share.js";
import { createShareZip, createUserZip, serveShareZip, serveUserZip } from "../services/zip.js";
import { type AppContext, mapError } from "./http.js";

export async function handleCreateZip(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(await createUserZip(context.env, user, context.req.param("nodeId")), 201);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleDownloadZip(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return await serveUserZip(context.env, user, context.req.param("id"));
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreatePublicZip(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json(
      await createShareZip(context.env, authentication, context.req.param("nodeId")),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleDownloadPublicZip(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return await serveShareZip(context.env, authentication, context.req.param("zipId"));
  } catch (error) {
    return mapError(context, error);
  }
}
