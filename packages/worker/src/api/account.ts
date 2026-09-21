import { authenticateAccessUser } from "../auth/httpAuth.js";
import { issueCsrfToken, verifyCsrfToken } from "../auth/csrf.js";
import { logoutAccessSession } from "../auth/sessions.js";
import { lookupOperation } from "../services/operations.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function csrfSecret(env: AppContext["env"]): string {
  const secret = env.CSRF_KEY ?? env.DEV_CSRF_KEY;
  if (secret === undefined || secret.length < 16) {
    throw new Error("csrf_configuration_invalid");
  }
  if (
    env.CSRF_KEY === undefined &&
    env.ENVIRONMENT !== "development" &&
    env.ENVIRONMENT !== "test"
  ) {
    throw new Error("csrf_configuration_invalid");
  }
  return secret;
}

function sameOrigin(context: AppContext): boolean {
  return (
    context.req.header("Origin") === context.env.APP_ORIGIN &&
    context.req.header("Sec-Fetch-Site") === "same-origin"
  );
}

export async function enforceCsrf(context: AppContext): Promise<Response | null> {
  try {
    if (!sameOrigin(context)) {
      return jsonError(context, 403, "csrf_failed", "The request origin is not allowed");
    }
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const token = context.req.header("X-CSRF-Token");
    if (
      token === undefined ||
      !(await verifyCsrfToken(csrfSecret(context.env), token, user.principal.sessionId))
    ) {
      return jsonError(context, 403, "csrf_failed", "The CSRF token is invalid");
    }
    return null;
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCsrf(context: AppContext): Promise<Response> {
  try {
    if (!sameOrigin(context)) {
      return jsonError(context, 403, "csrf_failed", "The request origin is not allowed");
    }
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({
      token: await issueCsrfToken(csrfSecret(context.env), user.principal.sessionId),
      expiresIn: 3600,
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleLogout(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    await logoutAccessSession(context.env, user.principal.sessionId, user.principal.userId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleOperation(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const operation = await lookupOperation(
      context.env,
      context.req.param("id"),
      user.principal.credentialId,
    );
    return operation === null
      ? jsonError(context, 404, "not_found", "The operation was not found")
      : context.json(operation);
  } catch (error) {
    return mapError(context, error);
  }
}
