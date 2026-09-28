import { ContentTokens, contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { globalKdf } from "../auth/globalKdf";
import { NodeCursorTokens } from "../auth/nodeCursor";
import { ShareTokens } from "../auth/shareTokens";
import { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import type { PublicShareDependencies } from "./publicShares";

export async function publicShareDependencies(
  env: Env,
  epoch: number,
): Promise<PublicShareDependencies> {
  if (
    !env.SHARE_COOKIE_KEYS ||
    !env.SHARE_COOKIE_ACTIVE_KID ||
    !env.CSRF_PUBLIC_KEYS ||
    !env.CSRF_PUBLIC_ACTIVE_KID
  )
    throw new Error("public_share_config_unavailable");
  const cookie = await contentKeyRing(
    env.SHARE_COOKIE_ACTIVE_KID,
    JSON.parse(env.SHARE_COOKIE_KEYS),
  );
  const publicRing = await csrfKeyRing(
    env.CSRF_PUBLIC_ACTIVE_KID,
    JSON.parse(env.CSRF_PUBLIC_KEYS),
  );
  const passwords =
    env.SHARE_PASSWORD_KEYS && env.SHARE_PASSWORD_ACTIVE_KID
      ? {
          ...(await contentKeyRing(
            env.SHARE_PASSWORD_ACTIVE_KID,
            JSON.parse(env.SHARE_PASSWORD_KEYS),
          )),
          derive: globalKdf(env.CONTROL, epoch),
        }
      : undefined;
  const cursors =
    env.NODE_CURSOR_KEYS && env.NODE_CURSOR_ACTIVE_KID
      ? new NodeCursorTokens(
          await contentKeyRing(env.NODE_CURSOR_ACTIVE_KID, JSON.parse(env.NODE_CURSOR_KEYS)),
        )
      : undefined;
  const contentTokens =
    env.CONTENT_TICKET_KEYS &&
    env.CONTENT_TICKET_ACTIVE_KID &&
    env.CONTENT_COOKIE_KEYS &&
    env.CONTENT_COOKIE_ACTIVE_KID
      ? new ContentTokens(
          await contentKeyRing(env.CONTENT_TICKET_ACTIVE_KID, JSON.parse(env.CONTENT_TICKET_KEYS)),
          await contentKeyRing(env.CONTENT_COOKIE_ACTIVE_KID, JSON.parse(env.CONTENT_COOKIE_KEYS)),
          env.CONTENT_ORIGIN,
        )
      : undefined;
  return {
    tokens: new ShareTokens(cookie, env.APP_ORIGIN),
    csrf: new CsrfTokens({ activeKid: "unavailable", keys: new Map() }, publicRing, env.APP_ORIGIN),
    ...(passwords ? { passwords } : {}),
    ...(cursors ? { cursors } : {}),
    ...(contentTokens ? { contentTokens } : {}),
    ...(env.UPLOAD_CAPABILITY_KEYS && env.UPLOAD_CAPABILITY_ACTIVE_KID
      ? {
          uploads: new UploadCapabilities(
            await contentKeyRing(
              env.UPLOAD_CAPABILITY_ACTIVE_KID,
              JSON.parse(env.UPLOAD_CAPABILITY_KEYS),
            ),
          ),
        }
      : {}),
  };
}
