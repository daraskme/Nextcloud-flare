import { contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { globalKdf } from "../auth/globalKdf";
import { ShareTokens } from "../auth/shareTokens";
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
  return {
    tokens: new ShareTokens(cookie, env.APP_ORIGIN),
    csrf: new CsrfTokens({ activeKid: "unavailable", keys: new Map() }, publicRing, env.APP_ORIGIN),
    ...(passwords ? { passwords } : {}),
  };
}
