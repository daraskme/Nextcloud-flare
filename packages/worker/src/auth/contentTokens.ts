import { base64url, jwtVerify, SignJWT } from "jose";
import type { ContentPurpose } from "./contentSession";

export interface ContentKeyRing {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

export async function contentKeyRing(
  activeKid: string,
  keys: Readonly<Record<string, string>>,
): Promise<ContentKeyRing> {
  if (
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 3 ||
    !Object.hasOwn(keys, activeKid)
  )
    throw new Error("invalid_content_key_ring");
  const imported = new Map<string, CryptoKey>();
  for (const [kid, encoded] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
      throw new Error("invalid_content_key_ring");
    const bytes = base64url.decode(encoded);
    if (bytes.length !== 32 || base64url.encode(bytes) !== encoded)
      throw new Error("invalid_content_key_ring");
    imported.set(
      kid,
      await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]),
    );
  }
  return { activeKid, keys: imported };
}

export interface ContentTicketClaims {
  readonly ticket_id: string;
  readonly credential_id: string;
  readonly target_set_id: string;
  readonly target_set_hash: string;
  readonly budget_id: string;
  readonly purpose: ContentPurpose;
  readonly epoch: number;
  readonly user_id: string | null;
  readonly share_id: string | null;
  readonly share_version: number | null;
  readonly iat: number;
  readonly exp: number;
}

const TOKEN_FIELDS =
  "aud,budget_id,credential_id,epoch,exp,iat,kid,purpose,share_id,share_version,target_set_hash,target_set_id,ticket_id,typ,user_id";
const ID = /^[A-Za-z0-9_:-]{1,256}$/;
const BUDGET_ID = /^[A-Za-z0-9_:-]{1,512}$/;

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))),
  );
}

function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "https:";
  } catch {
    return false;
  }
}

function validClaims(claims: ContentTicketClaims, now: number): boolean {
  return (
    [claims.ticket_id, claims.credential_id, claims.target_set_id].every(
      (value) => typeof value === "string" && ID.test(value),
    ) &&
    typeof claims.budget_id === "string" &&
    BUDGET_ID.test(claims.budget_id) &&
    /^[a-f0-9]{64}$/.test(claims.target_set_hash) &&
    ["content", "thumb", "page", "zip", "track"].includes(claims.purpose) &&
    Number.isSafeInteger(claims.epoch) &&
    claims.epoch > 0 &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    claims.iat <= now &&
    claims.exp > now &&
    claims.exp - claims.iat <= 600 &&
    claims.exp - claims.iat > 0 &&
    (claims.user_id === null || (typeof claims.user_id === "string" && ID.test(claims.user_id))) &&
    (claims.share_id === null ||
      (typeof claims.share_id === "string" && ID.test(claims.share_id))) &&
    (claims.share_id === null) === (claims.share_version === null) &&
    (claims.share_version === null ||
      (Number.isSafeInteger(claims.share_version) && claims.share_version > 0)) &&
    (claims.user_id !== null || claims.share_id !== null)
  );
}

export class ContentTokens {
  constructor(
    readonly ticketRing: ContentKeyRing,
    readonly cookieRing: ContentKeyRing,
    readonly origin: string,
    readonly now: () => number = Date.now,
  ) {
    if (!validOrigin(origin)) throw new Error("invalid_content_origin");
  }

  async issueTicket(claims: ContentTicketClaims): Promise<string> {
    const now = Math.floor(this.now() / 1000);
    if (!validClaims(claims, now)) throw new Error("invalid_content_ticket");
    const kid = this.ticketRing.activeKid;
    const key = this.ticketRing.keys.get(kid);
    if (!key) throw new Error("invalid_content_key_ring");
    const payload = JSON.parse(
      canonical({ ...claims, aud: this.origin, kid, typ: "content_ticket" }),
    );
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "ncf-content-ticket", kid })
      .sign(key);
    if (token.length > 2048) throw new Error("invalid_content_ticket");
    return token;
  }

  async verifyTicket(token: string): Promise<ContentTicketClaims> {
    try {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error("invalid_token");
      const signature = token.split(".")[2] ?? "";
      if (base64url.encode(base64url.decode(signature)) !== signature)
        throw new Error("invalid_token");
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          if (
            Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
            header.alg !== "HS256" ||
            header.typ !== "ncf-content-ticket" ||
            !header.kid
          )
            throw new Error("invalid_token");
          const key = this.ticketRing.keys.get(header.kid);
          if (!key) throw new Error("unknown_key");
          return key;
        },
        {
          algorithms: ["HS256"],
          typ: "ncf-content-ticket",
          audience: this.origin,
          currentDate: new Date(this.now()),
          requiredClaims: ["iat", "exp", "epoch", "ticket_id", "credential_id", "target_set_id"],
        },
      );
      if (
        payload.aud !== this.origin ||
        payload.typ !== "content_ticket" ||
        payload.kid !== protectedHeader.kid ||
        Object.keys(payload).sort().join(",") !== TOKEN_FIELDS ||
        new TextDecoder().decode(base64url.decode(token.split(".")[1] ?? "")) !==
          canonical(payload) ||
        !validClaims(payload as unknown as ContentTicketClaims, Math.floor(this.now() / 1000))
      )
        throw new Error("invalid_token");
      return Object.freeze({
        ticket_id: payload.ticket_id as string,
        credential_id: payload.credential_id as string,
        target_set_id: payload.target_set_id as string,
        target_set_hash: payload.target_set_hash as string,
        budget_id: payload.budget_id as string,
        purpose: payload.purpose as ContentPurpose,
        epoch: payload.epoch as number,
        user_id: payload.user_id as string | null,
        share_id: payload.share_id as string | null,
        share_version: payload.share_version as number | null,
        iat: payload.iat as number,
        exp: payload.exp as number,
      });
    } catch {
      throw new Error("content_ticket_rejected");
    }
  }

  async issueCookie(sessionId: string, maxAgeSeconds: number): Promise<string> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(sessionId) ||
      !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds < 1 ||
      maxAgeSeconds > 600
    )
      throw new Error("invalid_content_cookie");
    const kid = this.cookieRing.activeKid;
    const key = this.cookieRing.keys.get(kid);
    if (!key) throw new Error("invalid_content_key_ring");
    const message = new TextEncoder().encode(
      `ncf-content-cookie\0${this.origin}\0${kid}\0${sessionId}`,
    );
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, message)),
    );
    return `__Host-ncf_cs=${kid}.${sessionId}.${signature}; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  async verifyCookie(header: string | null): Promise<string> {
    try {
      if (!header || header.length > 8192) throw new Error("invalid_cookie");
      const matches = header
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("__Host-ncf_cs="));
      if (matches.length !== 1) throw new Error("invalid_cookie");
      const value = matches[0]?.slice("__Host-ncf_cs=".length) ?? "";
      const parts = value.split(".");
      if (
        parts.length !== 3 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(parts[0] ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[1] ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")
      )
        throw new Error("invalid_cookie");
      const [kid, sessionId, signature] = parts as [string, string, string];
      if (
        base64url.encode(base64url.decode(sessionId)) !== sessionId ||
        base64url.encode(base64url.decode(signature)) !== signature
      )
        throw new Error("invalid_cookie");
      const key = this.cookieRing.keys.get(kid);
      if (!key) throw new Error("unknown_key");
      const message = new TextEncoder().encode(
        `ncf-content-cookie\0${this.origin}\0${kid}\0${sessionId}`,
      );
      if (!(await crypto.subtle.verify("HMAC", key, base64url.decode(signature), message)))
        throw new Error("invalid_cookie");
      return sessionId;
    } catch {
      throw new Error("content_cookie_rejected");
    }
  }
}
