import { ContentTokens, contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";

export interface PublicShareDependencies {
  readonly csrf: CsrfTokens;
  readonly cursors?: NodeCursorTokens;
  readonly tokens?: ContentTokens;
}

export async function publicShareDependencies(env: Env): Promise<PublicShareDependencies> {
  if (
    !env.CSRF_PRIVATE_KEYS ||
    !env.CSRF_PUBLIC_KEYS ||
    !env.CSRF_PRIVATE_ACTIVE_KID ||
    !env.CSRF_PUBLIC_ACTIVE_KID
  )
    throw new Error("public_share_config_unavailable");
  const [privateRing, publicRing] = await Promise.all([
    csrfKeyRing(env.CSRF_PRIVATE_ACTIVE_KID, JSON.parse(env.CSRF_PRIVATE_KEYS)),
    csrfKeyRing(env.CSRF_PUBLIC_ACTIVE_KID, JSON.parse(env.CSRF_PUBLIC_KEYS)),
  ]);
  const cursorRing =
    env.NODE_CURSOR_KEYS && env.NODE_CURSOR_ACTIVE_KID
      ? await contentKeyRing(env.NODE_CURSOR_ACTIVE_KID, JSON.parse(env.NODE_CURSOR_KEYS))
      : undefined;
  const contentConfigured = [
    env.CONTENT_TICKET_KEYS,
    env.CONTENT_COOKIE_KEYS,
    env.CONTENT_TICKET_ACTIVE_KID,
    env.CONTENT_COOKIE_ACTIVE_KID,
  ];
  if (contentConfigured.some(Boolean) && !contentConfigured.every(Boolean))
    throw new Error("public_share_config_unavailable");
  const [ticketRing, cookieRing] = contentConfigured.every(Boolean)
    ? await Promise.all([
        contentKeyRing(env.CONTENT_TICKET_ACTIVE_KID!, JSON.parse(env.CONTENT_TICKET_KEYS!)),
        contentKeyRing(env.CONTENT_COOKIE_ACTIVE_KID!, JSON.parse(env.CONTENT_COOKIE_KEYS!)),
      ])
    : [undefined, undefined];
  return {
    csrf: new CsrfTokens(privateRing, publicRing, env.APP_ORIGIN),
    ...(cursorRing ? { cursors: new NodeCursorTokens(cursorRing) } : {}),
    ...(ticketRing && cookieRing
      ? { tokens: new ContentTokens(ticketRing, cookieRing, env.CONTENT_ORIGIN) }
      : {}),
  };
}
