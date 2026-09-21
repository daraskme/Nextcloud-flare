import { createAppPasswordBodySchema } from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import {
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
} from "../services/appPasswords.js";
import { type AppContext, mapError } from "./http.js";

export async function handleListAppPasswords(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({ items: await listAppPasswords(context.env, user.principal.userId) });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreateAppPassword(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = createAppPasswordBodySchema.parse(await context.req.json());
    return context.json(await createAppPassword(context.env, user, body), 201);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleRevokeAppPassword(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    await revokeAppPassword(context.env, user, context.req.param("credentialId"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
