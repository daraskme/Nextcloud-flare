import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface GalleryCursorClaims {
  readonly aud: "ncf-gallery";
  readonly rootId: string;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly recursive: boolean;
  readonly lastSort: number;
  readonly lastId: string;
  readonly iat: number;
  readonly exp: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function valid(value: GalleryCursorClaims, now: number): boolean {
  return (
    value.aud === "ncf-gallery" &&
    [value.rootId, value.spaceId, value.ownerId, value.userId, value.lastId].every(
      (item) => typeof item === "string" && ID.test(item),
    ) &&
    typeof value.credentialId === "string" &&
    /^[A-Za-z0-9:_-]{1,256}$/.test(value.credentialId) &&
    typeof value.recursive === "boolean" &&
    Number.isSafeInteger(value.lastSort) &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch > 0 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    value.iat <= now &&
    value.exp > now &&
    value.exp - value.iat === 600
  );
}

export class GalleryCursorTokens {
  constructor(
    readonly ring: ContentKeyRing,
    readonly now: () => number = Date.now,
  ) {}

  async issue(claims: Omit<GalleryCursorClaims, "aud" | "iat" | "exp">): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const payload: GalleryCursorClaims = {
      ...claims,
      aud: "ncf-gallery",
      iat: now,
      exp: now + 600,
    };
    if (!valid(payload, now)) throw new Error("invalid_gallery_cursor");
    const kid = this.ring.activeKid;
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error("invalid_gallery_cursor");
    const header = base64url.encode(JSON.stringify({ alg: "HS256", kid, typ: "ncf-gallery" }));
    const body = base64url.encode(JSON.stringify(payload));
    const input = `${header}.${body}`;
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))),
    );
    return `${input}.${signature}`;
  }

  async verify(token: string): Promise<GalleryCursorClaims> {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error("invalid_gallery_cursor");
      const [headerText, bodyText, signatureText] = token.split(".");
      const header = JSON.parse(new TextDecoder().decode(base64url.decode(headerText ?? "")));
      if (
        !header ||
        typeof header.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(header.kid) ||
        headerText !==
          base64url.encode(JSON.stringify({ alg: "HS256", kid: header.kid, typ: "ncf-gallery" }))
      )
        throw new Error("invalid_gallery_cursor");
      const key = this.ring.keys.get(header.kid);
      if (
        !key ||
        !signatureText ||
        base64url.encode(base64url.decode(signatureText)) !== signatureText
      )
        throw new Error("invalid_gallery_cursor");
      const input = `${headerText}.${bodyText}`;
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          base64url.decode(signatureText),
          new TextEncoder().encode(input),
        ))
      )
        throw new Error("invalid_gallery_cursor");
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        base64url.decode(bodyText ?? ""),
      );
      const payload = JSON.parse(decoded) as GalleryCursorClaims;
      if (
        Object.keys(payload).sort().join(",") !==
          "aud,credentialId,epoch,exp,generation,iat,lastId,lastSort,ownerId,recursive,rootId,spaceId,userId" ||
        !valid(payload, Math.floor(this.now() / 1000)) ||
        base64url.encode(JSON.stringify(payload)) !== bodyText
      )
        throw new Error("invalid_gallery_cursor");
      return Object.freeze(payload);
    } catch {
      throw new Error("invalid_gallery_cursor");
    }
  }
}
