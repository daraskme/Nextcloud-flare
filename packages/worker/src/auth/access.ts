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
  constructor() {
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
    try {
      // Headers coalesces duplicates with commas. Only one compact JWT is accepted.
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (
        !token ||
        token.length > 16_384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error("invalid_assertion");
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "RS256" ||
        header.typ !== "JWT" ||
        !text(header.kid, 256) ||
        Object.keys(header).some((key) => !["alg", "typ", "kid"].includes(key))
      )
        throw new Error("invalid_header");
      const audience = kind === "user" ? this.userAudience : this.serviceAudience;
      const currentDate = new Date(this.now());
      const { payload } = await jwtVerify(token, await this.jwks.resolver(header.kid), {
        algorithms: ["RS256"],
        typ: "JWT",
        issuer: this.jwks.issuer,
        audience,
        clockTolerance: 60,
        currentDate,
        requiredClaims:
          kind === "user"
            ? ["iat", "exp", "nbf", "sub", "email", "type"]
            : ["iat", "exp", "common_name", "type"],
      });
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
    } catch {
      throw new AccessAuthenticationError();
    }
  }
}
