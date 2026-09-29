import { contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";

export interface PublicShareDependencies {
  readonly csrf: CsrfTokens;
  readonly cursors?: NodeCursorTokens;
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
  return {
    csrf: new CsrfTokens(privateRing, publicRing, env.APP_ORIGIN),
    ...(cursorRing ? { cursors: new NodeCursorTokens(cursorRing) } : {}),
  };
}
