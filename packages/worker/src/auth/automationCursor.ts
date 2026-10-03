import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface AutomationCursor {
  readonly servicePrincipalId: string;
  readonly credentialId: string;
  readonly mappedUserId: string;
  readonly spaceId: string;
  readonly scopeRootId: string;
  readonly generation: number;
  readonly lastNameCi: string;
  readonly lastId: string;
  readonly epoch: number;
  readonly iat: number;
  readonly exp: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class AutomationCursorTokens {
  constructor(
    readonly ring: ContentKeyRing,
    readonly now: () => number = Date.now,
  ) {}

  async issue(claims: Omit<AutomationCursor, "iat" | "exp">): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const value: AutomationCursor = { ...claims, iat, exp: iat + 600 };
    if (!valid(value, iat)) throw new Error("invalid_automation_cursor");
    const kid = this.ring.activeKid;
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error("invalid_automation_cursor");
    const header = base64url.encode(
      JSON.stringify({ alg: "HS256", kid, typ: "ncf-automation-cursor" }),
    );
    const body = base64url.encode(JSON.stringify(value));
    const input = `${header}.${body}`;
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))),
    );
    const token = `${input}.${signature}`;
    if (token.length > 4096) throw new Error("invalid_automation_cursor");
    return token;
  }

  async verify(token: string): Promise<AutomationCursor> {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error();
      const [headerText, bodyText, signatureText] = token.split(".");
      const header = JSON.parse(new TextDecoder().decode(base64url.decode(headerText ?? "")));
      if (
        !header ||
        typeof header.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(header.kid) ||
        headerText !==
          base64url.encode(
            JSON.stringify({ alg: "HS256", kid: header.kid, typ: "ncf-automation-cursor" }),
          )
      )
        throw new Error();
      const key = this.ring.keys.get(header.kid);
      if (
        !key ||
        !signatureText ||
        base64url.encode(base64url.decode(signatureText)) !== signatureText
      )
        throw new Error();
      const input = `${headerText}.${bodyText}`;
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          base64url.decode(signatureText),
          new TextEncoder().encode(input),
        ))
      )
        throw new Error();
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          base64url.decode(bodyText ?? ""),
        ),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const cursor = value as AutomationCursor;
      if (
        Object.keys(cursor).sort().join(",") !==
          "credentialId,epoch,exp,generation,iat,lastId,lastNameCi,mappedUserId,scopeRootId,servicePrincipalId,spaceId" ||
        !valid(cursor, Math.floor(this.now() / 1000)) ||
        base64url.encode(JSON.stringify(cursor)) !== bodyText
      )
        throw new Error();
      return Object.freeze(cursor);
    } catch {
      throw new Error("invalid_automation_cursor");
    }
  }
}

function valid(value: AutomationCursor, now: number): boolean {
  return (
    [
      value.servicePrincipalId,
      value.mappedUserId,
      value.spaceId,
      value.scopeRootId,
      value.lastId,
    ].every((item) => ID.test(item)) &&
    /^[A-Za-z0-9:_-]{1,256}$/.test(value.credentialId) &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch > 0 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.lastNameCi === "string" &&
    value.lastNameCi.length <= 1024 &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    value.iat <= now &&
    value.exp > now &&
    value.exp - value.iat === 600
  );
}
