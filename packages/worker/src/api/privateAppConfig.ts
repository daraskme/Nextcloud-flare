import { AccessVerifier } from "../auth/access";
import { appPasswordPepperRing } from "../auth/appPassword";
import type { BootstrapPolicy } from "../auth/bootstrap";
import { ContentTokens, contentKeyRing } from "../auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../auth/csrf";
import { AccessJwks } from "../auth/jwks";
import { ListCursorTokens } from "../auth/listCursor";
import { NodeCursorTokens } from "../auth/nodeCursor";
import { SearchCursorTokens } from "../auth/searchCursor";
import { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import type { PrivateAppDependencies } from "./privateApp";

let jwks: AccessJwks | undefined;

function bootstrapPolicy(env: Env): BootstrapPolicy {
  const emails: unknown = JSON.parse(env.BOOTSTRAP_OWNER_EMAILS ?? "null");
  const identities: unknown = JSON.parse(env.BOOTSTRAP_OWNER_IDENTITIES ?? "null");
  const quotaBytes = Number(env.BOOTSTRAP_QUOTA_BYTES);
  if (
    !Array.isArray(emails) ||
    emails.length > 16 ||
    !emails.every((value) => typeof value === "string" && value.length <= 320) ||
    !Array.isArray(identities) ||
    identities.length > 16 ||
    !identities.every(
      (value) =>
        value &&
        typeof value === "object" &&
        Object.keys(value).sort().join(",") === "iss,sub" &&
        typeof value.iss === "string" &&
        typeof value.sub === "string" &&
        value.iss.length <= 2048 &&
        value.sub.length <= 1024,
    ) ||
    emails.length + identities.length === 0 ||
    !Number.isSafeInteger(quotaBytes) ||
    quotaBytes < 0 ||
    quotaBytes > 7_505_999_378_950_825
  )
    throw new Error("invalid_private_app_config");
  return { ownerEmails: emails, ownerIdentities: identities, quotaBytes };
}

/** Remote identity and signing material are mandatory; local bindings intentionally omit them. */
export async function privateAppDependencies(env: Env): Promise<PrivateAppDependencies> {
  if (
    !env.ACCESS_ISSUER ||
    !env.ACCESS_USER_AUDIENCE ||
    !env.ACCESS_SERVICE_AUDIENCE ||
    !env.CSRF_PRIVATE_KEYS ||
    !env.CSRF_PUBLIC_KEYS ||
    !env.CSRF_PRIVATE_ACTIVE_KID ||
    !env.CSRF_PUBLIC_ACTIVE_KID ||
    !env.CONTENT_TICKET_KEYS ||
    !env.CONTENT_COOKIE_KEYS ||
    !env.CONTENT_TICKET_ACTIVE_KID ||
    !env.CONTENT_COOKIE_ACTIVE_KID
  )
    throw new Error("private_app_config_unavailable");
  if (!jwks || jwks.issuer !== env.ACCESS_ISSUER)
    jwks = new AccessJwks(env.ACCESS_ISSUER, env.CACHE);
  const [privateRing, publicRing, ticketRing, cookieRing] = await Promise.all([
    csrfKeyRing(env.CSRF_PRIVATE_ACTIVE_KID, JSON.parse(env.CSRF_PRIVATE_KEYS)),
    csrfKeyRing(env.CSRF_PUBLIC_ACTIVE_KID, JSON.parse(env.CSRF_PUBLIC_KEYS)),
    contentKeyRing(env.CONTENT_TICKET_ACTIVE_KID, JSON.parse(env.CONTENT_TICKET_KEYS)),
    contentKeyRing(env.CONTENT_COOKIE_ACTIVE_KID, JSON.parse(env.CONTENT_COOKIE_KEYS)),
  ]);
  const cursorRing =
    env.NODE_CURSOR_KEYS && env.NODE_CURSOR_ACTIVE_KID
      ? await contentKeyRing(env.NODE_CURSOR_ACTIVE_KID, JSON.parse(env.NODE_CURSOR_KEYS))
      : undefined;
  const appPasswordPepper =
    env.APP_PASSWORD_PEPPERS && env.APP_PASSWORD_ACTIVE_KID
      ? await appPasswordPepperRing(
          env.APP_PASSWORD_ACTIVE_KID,
          JSON.parse(env.APP_PASSWORD_PEPPERS),
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
    verifier: new AccessVerifier(jwks, env.ACCESS_USER_AUDIENCE, env.ACCESS_SERVICE_AUDIENCE),
    csrf: new CsrfTokens(privateRing, publicRing, env.APP_ORIGIN),
    tokens: new ContentTokens(ticketRing, cookieRing, env.CONTENT_ORIGIN),
    ...(cursorRing ? { searchCursors: new SearchCursorTokens(cursorRing) } : {}),
    ...(cursorRing ? { cursors: new NodeCursorTokens(cursorRing) } : {}),
    ...(cursorRing ? { listCursors: new ListCursorTokens(cursorRing) } : {}),
    ...(appPasswordPepper ? { appPasswordPepper } : {}),
    ...(uploadCapabilities ? { uploadCapabilities } : {}),
    bootstrap: bootstrapPolicy(env),
  };
}
