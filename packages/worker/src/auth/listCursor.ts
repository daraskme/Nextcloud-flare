import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface ListCursorClaims {
  readonly aud: "trash";
  readonly scopeId: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly lastSort: number;
  readonly lastId: string;
  readonly iat: number;
  readonly exp: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function valid(value: ListCursorClaims, now: number): boolean {
  return (
    value.aud === "trash" &&
    ID.test(value.scopeId) &&
    ID.test(value.userId) &&
    /^[A-Za-z0-9:_-]{1,256}$/.test(value.credentialId) &&
    ID.test(value.lastId) &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch > 0 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    Number.isSafeInteger(value.lastSort) &&
    value.lastSort >= 0 &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    value.iat <= now &&
    value.exp > now &&
    value.exp - value.iat === 600
  );
}

/** Purpose-bound HMAC cursor for private keyset lists outside a node parent. */
export class ListCursorTokens {
  constructor(
    readonly ring: ContentKeyRing,
    readonly now: () => number = Date.now,
  ) {}

  async issue(claims: Omit<ListCursorClaims, "iat" | "exp">): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const payload: ListCursorClaims = { ...claims, iat: now, exp: now + 600 };
    if (!valid(payload, now)) throw new Error("invalid_list_cursor");
    const kid = this.ring.activeKid;
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error("invalid_list_cursor");
    const header = base64url.encode(JSON.stringify({ alg: "HS256", kid, typ: "ncf-list-cursor" }));
    const body = base64url.encode(JSON.stringify(payload));
    const input = `${header}.${body}`;
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))),
    );
    const token = `${input}.${signature}`;
    if (token.length > 4096) throw new Error("invalid_list_cursor");
    return token;
  }

  async verify(token: string): Promise<ListCursorClaims> {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error("invalid_list_cursor");
      const [headerText, bodyText, signatureText] = token.split(".");
      const header = JSON.parse(new TextDecoder().decode(base64url.decode(headerText ?? "")));
      if (
        !header ||
        typeof header.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(header.kid) ||
        headerText !==
          base64url.encode(
            JSON.stringify({ alg: "HS256", kid: header.kid, typ: "ncf-list-cursor" }),
          )
      )
        throw new Error("invalid_list_cursor");
      const key = this.ring.keys.get(header.kid);
      if (
        !key ||
        !signatureText ||
        base64url.encode(base64url.decode(signatureText)) !== signatureText
      )
        throw new Error("invalid_list_cursor");
      const input = `${headerText}.${bodyText}`;
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          base64url.decode(signatureText),
          new TextEncoder().encode(input),
        ))
      )
        throw new Error("invalid_list_cursor");
      const body: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          base64url.decode(bodyText ?? ""),
        ),
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("invalid_list_cursor");
      const payload = body as ListCursorClaims;
      if (
        Object.keys(payload).sort().join(",") !==
          "aud,credentialId,epoch,exp,generation,iat,lastId,lastSort,scopeId,userId" ||
        !valid(payload, Math.floor(this.now() / 1000)) ||
        base64url.encode(JSON.stringify(payload)) !== bodyText
      )
        throw new Error("invalid_list_cursor");
      return Object.freeze(payload);
    } catch {
      throw new Error("invalid_list_cursor");
    }
  }
}
