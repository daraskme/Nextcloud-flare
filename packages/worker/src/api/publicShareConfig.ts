import { ContentTokens, contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { globalKdf } from "../auth/globalKdf";
import { NodeCursorTokens } from "../auth/nodeCursor";
import { type SharePasswordPepperRing, sharePasswordPepperRing } from "../auth/sharePassword";
import { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";

export interface PublicShareDependencies {
  readonly csrf: CsrfTokens;
  readonly cursors?: NodeCursorTokens;
  readonly tokens?: ContentTokens;
  readonly passwordPepper?: SharePasswordPepperRing;
  readonly uploadCapabilities?: UploadCapabilities;
}

export async function publicShareDependencies(
  env: Env,
  epoch: number,
): Promise<PublicShareDependencies> {
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
  const passwordPepper =
    env.SHARE_PASSWORD_PEPPERS && env.SHARE_PASSWORD_ACTIVE_KID
      ? await sharePasswordPepperRing(
          env.SHARE_PASSWORD_ACTIVE_KID,
          JSON.parse(env.SHARE_PASSWORD_PEPPERS),
          globalKdf(env.CONTROL, epoch),
        )
      : undefined;
  const uploadCapabilities =
    env.UPLOAD_CAPABILITY_KEYS && env.UPLOAD_CAPABILITY_ACTIVE_KID
      ? new UploadCapabilities(
          await contentKeyRing(
            env.UPLOAD_CAPABILITY_ACTIVE_KID,
            JSON.parse(env.UPLOAD_CAPABILITY_KEYS),
          ),
        )
      : undefined;
  return {
    csrf: new CsrfTokens(privateRing, publicRing, env.APP_ORIGIN),
    ...(cursorRing ? { cursors: new NodeCursorTokens(cursorRing) } : {}),
    ...(ticketRing && cookieRing
      ? { tokens: new ContentTokens(ticketRing, cookieRing, env.CONTENT_ORIGIN) }
      : {}),
    ...(passwordPepper ? { passwordPepper } : {}),
    ...(uploadCapabilities ? { uploadCapabilities } : {}),
  };
}
