import { createContentSessionBodySchema } from "@ncf/shared";
import { z } from "zod";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare } from "../auth/share.js";
import {
  acceptContentTicket,
  cancelContentTicket,
  createShareContentTicket,
  createUserContentTicket,
  serveContentSession,
} from "../services/contentSessions.js";
import { type AppContext, jsonError, mapError } from "./http.js";

const acceptBodySchema = z.object({ ticket: z.string().min(64).max(4096) });

function corsHeaders(context: AppContext): Headers {
  return new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": context.env.APP_ORIGIN,
    "Cache-Control": "private, no-store",
    Vary: "Origin",
  });
}

export async function handleCreateContentSession(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = createContentSessionBodySchema.parse(await context.req.json());
    return context.json(
      await createUserContentTicket(context.env, user, body.purpose, body.nodeIds),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreatePublicContentSession(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const body = createContentSessionBodySchema.parse(await context.req.json());
    return context.json(
      await createShareContentTicket(context.env, authentication, body.purpose, body.nodeIds),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export function handleContentSessionOptions(context: AppContext): Response {
  if (context.req.header("Origin") !== context.env.APP_ORIGIN) {
    return jsonError(context, 403, "cors_forbidden", "The request origin is not allowed");
  }
  return new Response(null, { status: 204, headers: corsHeaders(context) });
}

export async function handleContentSessionAccept(context: AppContext): Promise<Response> {
  try {
    if (context.req.header("Origin") !== context.env.APP_ORIGIN) {
      return jsonError(context, 403, "cors_forbidden", "The request origin is not allowed");
    }
    const length = Number(context.req.header("Content-Length") ?? "0");
    if (!Number.isSafeInteger(length) || length < 1 || length > 16_384) {
      return jsonError(context, 413, "payload_too_large", "Ticket request is too large");
    }
    const body = acceptBodySchema.parse(await context.req.json());
    const accepted = await acceptContentTicket(context.env, body.ticket);
    const headers = corsHeaders(context);
    headers.set("Set-Cookie", accepted.cookie);
    headers.set("Content-Type", "application/json; charset=UTF-8");
    return new Response(JSON.stringify({ expiresAt: accepted.expiresAt }), {
      status: 201,
      headers,
    });
  } catch (error) {
    const response = mapError(context, error);
    const headers = corsHeaders(context);
    for (const [key, value] of response.headers) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  }
}

export async function handleContentSessionRead(context: AppContext): Promise<Response> {
  try {
    return await serveContentSession(
      context.env,
      context.req.raw,
      context.req.param("nodeId"),
      context.req.param("blobId"),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCancelTicket(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    await cancelContentTicket(context.env, context.req.param("ticketId"), user.principal.sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCancelPublicTicket(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    await cancelContentTicket(context.env, context.req.param("ticketId"), authentication.sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
