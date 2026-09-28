import { base64url, jwtVerify, SignJWT } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface UnlockChallenge {
  share_id: string;
  epoch: number;
  nonce: string;
  iat: number;
  exp: number;
}
export interface ShareCookieClaims extends UnlockChallenge {
  session_id: string;
  share_version: number;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const canonical = (v: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, "en"))),
  );

export function shareCookieName(id: string, challenge = false): string {
  if (!ID.test(id)) throw new Error("share_cookie_rejected");
  return `__Host-ncf_${challenge ? "unlock" : "share"}_${id}`;
}
export function shareCookieValue(
  header: string | null,
  id: string,
  challenge = false,
): string | null {
  if (header === null) return null;
  if (header.length > 32768) throw new Error("share_cookie_rejected");
  const name = shareCookieName(id, challenge);
  const matches = header
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.split("=", 1)[0] === name);
  if (matches.length > 1) throw new Error("share_cookie_rejected");
  return matches[0]?.slice(name.length + 1) ?? null;
}
export function shareCookieHeader(id: string, token: string, maxAge: number, challenge = false) {
  if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 604800 || /[;\r\n]/.test(token))
    throw new Error("share_cookie_rejected");
  return `${shareCookieName(id, challenge)}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Dedicated cookie keys. Challenges and authenticated cookies have distinct signed purposes. */
export class ShareTokens {
  constructor(
    readonly ring: ContentKeyRing,
    readonly origin: string,
    readonly now = Date.now,
  ) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:") throw new Error("invalid_share_origin");
  }
  async challenge(shareId: string, epoch: number) {
    const iat = Math.floor(this.now() / 1000);
    const claims = {
      share_id: shareId,
      epoch,
      nonce: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      iat,
      exp: iat + 300,
    };
    return { claims, token: await this.#sign(claims, "share_unlock") };
  }
  async issue(claims: ShareCookieClaims) {
    return this.#sign(claims, "share_cookie");
  }
  async verifyChallenge(token: string, shareId: string, epoch: number) {
    return this.#verify(token, shareId, epoch, "share_unlock") as Promise<UnlockChallenge>;
  }
  async verify(token: string, shareId: string, epoch: number) {
    return this.#verify(token, shareId, epoch, "share_cookie") as Promise<ShareCookieClaims>;
  }
  #valid(claims: UnlockChallenge, kind: string) {
    const c = claims as ShareCookieClaims;
    return (
      typeof c.share_id === "string" &&
      ID.test(c.share_id) &&
      Number.isSafeInteger(c.epoch) &&
      c.epoch > 0 &&
      Number.isSafeInteger(c.iat) &&
      c.iat >= 0 &&
      c.iat <= Math.floor(this.now() / 1000) &&
      Number.isSafeInteger(c.exp) &&
      c.exp > Math.floor(this.now() / 1000) &&
      c.exp > c.iat &&
      c.exp - c.iat <= (kind === "share_unlock" ? 300 : 604800) &&
      typeof c.nonce === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(c.nonce) &&
      base64url.encode(base64url.decode(c.nonce)) === c.nonce &&
      (kind === "share_unlock" ||
        (typeof c.session_id === "string" &&
          ID.test(c.session_id) &&
          Number.isSafeInteger(c.share_version) &&
          c.share_version > 0))
    );
  }
  async #sign(claims: UnlockChallenge | ShareCookieClaims, kind: string) {
    if (!this.#valid(claims, kind)) throw new Error("share_cookie_rejected");
    const kid = this.ring.activeKid,
      key = this.ring.keys.get(kid);
    if (!key) throw new Error("share_cookie_unavailable");
    return new SignJWT(JSON.parse(canonical({ ...claims, aud: this.origin, kid, typ: kind })))
      .setProtectedHeader({ alg: "HS256", typ: `ncf-${kind}`, kid })
      .sign(key);
  }
  async #verify(
    token: string,
    shareId: string,
    epoch: number,
    kind: string,
  ): Promise<UnlockChallenge | ShareCookieClaims> {
    try {
      if (
        typeof token !== "string" ||
        token.length > 2048 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error();
      const signature = token.split(".")[2]!;
      if (base64url.encode(base64url.decode(signature)) !== signature) throw new Error();
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          if (Object.keys(header).sort().join(",") !== "alg,kid,typ" || !header.kid)
            throw new Error();
          const key = this.ring.keys.get(header.kid);
          if (!key) throw new Error();
          return key;
        },
        {
          algorithms: ["HS256"],
          typ: `ncf-${kind}`,
          audience: this.origin,
          currentDate: new Date(this.now()),
          requiredClaims: ["iat", "exp", "epoch", "nonce", "share_id", "kid", "typ"],
        },
      );
      const fields =
        kind === "share_unlock"
          ? "aud,epoch,exp,iat,kid,nonce,share_id,typ"
          : "aud,epoch,exp,iat,kid,nonce,session_id,share_id,share_version,typ";
      if (
        Object.keys(payload).sort().join(",") !== fields ||
        payload.aud !== this.origin ||
        payload.typ !== kind ||
        payload.kid !== protectedHeader.kid ||
        payload.share_id !== shareId ||
        payload.epoch !== epoch ||
        !this.#valid(payload as unknown as UnlockChallenge, kind) ||
        new TextDecoder().decode(base64url.decode(token.split(".")[1]!)) !== canonical(payload)
      )
        throw new Error();
      const { aud: _aud, typ: _typ, kid: _kid, ...claims } = payload;
      return claims as unknown as UnlockChallenge | ShareCookieClaims;
    } catch {
      throw new Error("share_cookie_rejected");
    }
  }
}
