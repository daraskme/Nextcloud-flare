import { decodeProtectedHeader, jwtVerify } from "jose";
import { AccessJwks } from "./jwks";
import type { AccessClaims } from "./sessions";

declare const verified: unique symbol;
export interface VerifiedAccessUser extends AccessClaims {
  readonly [verified]: true;
  readonly kind: "user";
  readonly email: string;
  readonly nbf: number;
}
export interface VerifiedAccessService {
  readonly [verified]: true;
  readonly kind: "service";
  readonly iss: string;
  readonly common_name: string;
  readonly iat: number;
  readonly exp: number;
}
export class AccessAuthenticationError extends Error {
  constructor(
    readonly stage: "assertion" | "header" | "jwks" | "jwt" | "claims" = "assertion",
    readonly headerCheck?: "decode" | "algorithm" | "type" | "key_id" | "extra_fields",
    readonly jwksCheck?:
      | "unavailable"
      | "timeout"
      | "invalid"
      | "unknown_key"
      | "rate_limited"
      | "fetch_error"
      | "other",
  ) {
    super("access_authentication_failed");
  }
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[|\x00-\x20\x7f]/.test(value)
  );
}
function timestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value * 1000)
  );
}

export class AccessVerifier {
  constructor(
    readonly jwks: AccessJwks,
    readonly userAudience: string,
    readonly serviceAudience: string,
    readonly now: () => number = Date.now,
  ) {
    if (!text(userAudience, 256) || !text(serviceAudience, 256) || userAudience === serviceAudience)
      throw new Error("invalid_access_audiences");
  }

  verify(request: Request, kind: "user"): Promise<VerifiedAccessUser>;
  verify(request: Request, kind: "service"): Promise<VerifiedAccessService>;
  async verify(
    request: Request,
    kind: "user" | "service",
  ): Promise<VerifiedAccessUser | VerifiedAccessService> {
    let stage: AccessAuthenticationError["stage"] = "assertion";
    let headerCheck: AccessAuthenticationError["headerCheck"];
    try {
      // Headers coalesces duplicates with commas. Only one compact JWT is accepted.
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (
        !token ||
        token.length > 16_384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error("invalid_assertion");
      stage = "header";
      headerCheck = "decode";
      const header = decodeProtectedHeader(token);
      headerCheck = "algorithm";
      if (header.alg !== "RS256") throw new Error("invalid_header");
      headerCheck = "type";
      // JWS typ is optional; require JWT when the issuer provides it.
      if (header.typ !== undefined && header.typ !== "JWT") throw new Error("invalid_header");
      headerCheck = "key_id";
      if (!text(header.kid, 256)) throw new Error("invalid_header");
      headerCheck = "extra_fields";
      if (Object.keys(header).some((key) => !["alg", "typ", "kid"].includes(key)))
        throw new Error("invalid_header");
      headerCheck = undefined;
      const audience = kind === "user" ? this.userAudience : this.serviceAudience;
      const currentDate = new Date(this.now());
      stage = "jwks";
      const resolver = await this.jwks.resolver(header.kid);
      stage = "jwt";
      const { payload } = await jwtVerify(token, resolver, {
        algorithms: ["RS256"],
        issuer: this.jwks.issuer,
        audience,
        clockTolerance: 60,
        currentDate,
        requiredClaims:
          kind === "user"
            ? ["iat", "exp", "nbf", "sub", "email", "type"]
            : ["iat", "exp", "common_name", "type"],
      });
      stage = "claims";
      if (
        payload.type !== "app" ||
        !(
          payload.aud === audience ||
          (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === audience)
        ) ||
        !timestamp(payload.iat) ||
        !timestamp(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 86_400 ||
        payload.iat > currentDate.getTime() / 1000 + 60 ||
        (payload.nbf !== undefined && (!timestamp(payload.nbf) || payload.nbf >= payload.exp))
      )
        throw new Error("invalid_claims");
      if (kind === "user") {
        if (
          !text(payload.sub, 1024) ||
          !text(payload.email, 320) ||
          !timestamp(payload.nbf) ||
          "common_name" in payload
        )
          throw new Error("invalid_user");
        return Object.freeze({
          kind,
          iss: this.jwks.issuer,
          sub: payload.sub,
          email: payload.email,
          nbf: payload.nbf,
          iat: payload.iat,
          exp: payload.exp,
        }) as VerifiedAccessUser;
      }
      if (
        !text(payload.common_name, 1024) ||
        payload.email !== undefined ||
        (payload.sub !== undefined && payload.sub !== "")
      )
        throw new Error("invalid_service");
      return Object.freeze({
        kind,
        iss: this.jwks.issuer,
        common_name: payload.common_name,
        iat: payload.iat,
        exp: payload.exp,
      }) as VerifiedAccessService;
    } catch (error) {
      let jwksCheck: AccessAuthenticationError["jwksCheck"];
      if (stage === "jwks") {
        const message = error instanceof Error ? error.message : "";
        jwksCheck =
          message === "jwks_unavailable"
            ? "unavailable"
            : message === "jwks_timeout"
              ? "timeout"
              : message === "invalid_jwks" || message === "jwks_too_large"
                ? "invalid"
                : message === "unknown_kid"
                  ? "unknown_key"
                  : message === "jwks_refresh_limited"
                    ? "rate_limited"
                    : error instanceof TypeError
                      ? "fetch_error"
                      : "other";
      }
      throw new AccessAuthenticationError(stage, headerCheck, jwksCheck);
    }
  }
}
