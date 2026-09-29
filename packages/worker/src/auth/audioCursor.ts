import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface AudioCursorClaims {
  readonly aud: "ncf-audio-tracks";
  readonly parentId: string;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly userId: string | null;
  readonly credentialId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly lastNameCi: string;
  readonly lastId: string;
  readonly generator: string;
  readonly emitted: number;
  readonly shareId?: string;
  readonly shareVersion?: number;
  readonly iat: number;
  readonly exp: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function valid(value: AudioCursorClaims, now: number): boolean {
  return (
    value.aud === "ncf-audio-tracks" &&
    typeof value.credentialId === "string" &&
    [value.parentId, value.spaceId, value.ownerId, value.lastId].every(
      (v) => typeof v === "string" && ID.test(v),
    ) &&
    (value.userId === null
      ? typeof value.shareId === "string" && value.credentialId.startsWith("ss:")
      : typeof value.userId === "string" && ID.test(value.userId)) &&
    /^[A-Za-z0-9:_-]{1,256}$/.test(value.credentialId) &&
    ID.test(value.lastId) &&
    ((value.shareId === undefined && value.shareVersion === undefined) ||
      (typeof value.shareId === "string" &&
        ID.test(value.shareId) &&
        Number.isSafeInteger(value.shareVersion) &&
        (value.shareVersion as number) > 0)) &&
    typeof value.lastNameCi === "string" &&
    value.lastNameCi.length <= 1024 &&
    value.generator === "track-metadata-v1" &&
    Number.isSafeInteger(value.emitted) &&
    value.emitted >= 0 &&
    value.emitted < 2000 &&
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

/** A separate HMAC kid ring binds one keyset page to its exact authority and tree generation. */
export class AudioCursorTokens {
  constructor(
    readonly ring: ContentKeyRing,
    readonly now: () => number = Date.now,
  ) {}

  async issue(claims: Omit<AudioCursorClaims, "aud" | "iat" | "exp">): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    const payload: AudioCursorClaims = {
      ...claims,
      aud: "ncf-audio-tracks",
      iat: now,
      exp: now + 600,
    };
    if (!valid(payload, now)) throw new Error("invalid_audio_cursor");
    const kid = this.ring.activeKid;
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error("invalid_audio_cursor");
    const header = base64url.encode(JSON.stringify({ alg: "HS256", kid, typ: "ncf-audio-cursor" }));
    const body = base64url.encode(JSON.stringify(payload));
    const input = `${header}.${body}`;
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))),
    );
    const token = `${input}.${signature}`;
    if (token.length > 4096) throw new Error("invalid_audio_cursor");
    return token;
  }

  async verify(token: string): Promise<AudioCursorClaims> {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error("invalid_audio_cursor");
      const [headerText, bodyText, signatureText] = token.split(".");
      const header = JSON.parse(new TextDecoder().decode(base64url.decode(headerText ?? "")));
      if (
        !header ||
        typeof header.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(header.kid) ||
        headerText !==
          base64url.encode(
            JSON.stringify({ alg: "HS256", kid: header.kid, typ: "ncf-audio-cursor" }),
          )
      )
        throw new Error("invalid_audio_cursor");
      const key = this.ring.keys.get(header.kid);
      if (
        !key ||
        !signatureText ||
        base64url.encode(base64url.decode(signatureText)) !== signatureText
      )
        throw new Error("invalid_audio_cursor");
      const input = `${headerText}.${bodyText}`;
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          base64url.decode(signatureText),
          new TextEncoder().encode(input),
        ))
      )
        throw new Error("invalid_audio_cursor");
      const body: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          base64url.decode(bodyText ?? ""),
        ),
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("invalid_audio_cursor");
      const payload = body as AudioCursorClaims;
      if (
        Object.keys(payload).sort().join(",") !==
          (payload.shareId === undefined
            ? "aud,credentialId,emitted,epoch,exp,generation,generator,iat,lastId,lastNameCi,ownerId,parentId,spaceId,userId"
            : "aud,credentialId,emitted,epoch,exp,generation,generator,iat,lastId,lastNameCi,ownerId,parentId,shareId,shareVersion,spaceId,userId") ||
        !valid(payload, Math.floor(this.now() / 1000)) ||
        base64url.encode(JSON.stringify(payload)) !== bodyText
      )
        throw new Error("invalid_audio_cursor");
      return Object.freeze(payload);
    } catch {
      throw new Error("invalid_audio_cursor");
    }
  }
}
