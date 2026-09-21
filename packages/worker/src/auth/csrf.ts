import { base64url, jwtVerify, SignJWT } from "jose";
import { primary } from "../db/primary";
import { readAccessSession } from "./sessions";

export type CsrfSession =
  | { readonly kind: "access"; readonly credentialId: string; readonly epoch: number }
  | {
      readonly kind: "share";
      readonly credentialId: string;
      readonly epoch: number;
      readonly shareId: string;
    };

export interface CsrfKeyRing {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/** Separate rings must be configured for private and public CSRF; secrets never enter clients. */
export async function csrfKeyRing(
  activeKid: string,
  keys: Readonly<Record<string, string>>,
): Promise<CsrfKeyRing> {
  if (
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 3 ||
    !Object.hasOwn(keys, activeKid)
  )
    throw new Error("invalid_csrf_key_ring");
  const imported = new Map<string, CryptoKey>();
  for (const [kid, encoded] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
      throw new Error("invalid_csrf_key_ring");
    const bytes = base64url.decode(encoded);
    if (bytes.length !== 32 || base64url.encode(bytes) !== encoded)
      throw new Error("invalid_csrf_key_ring");
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

async function liveSession(db: D1Database, session: CsrfSession): Promise<void> {
  if (
    !Number.isSafeInteger(session.epoch) ||
    session.epoch < 1 ||
    session.credentialId.length > 256
  )
    throw new Error("csrf_rejected");
  if (session.kind === "access") {
    if (!(await readAccessSession(db, session.credentialId, session.epoch)))
      throw new Error("csrf_rejected");
    return;
  }
  const found = await primary(db)
    .prepare(`SELECT 1 AS live FROM credentials c
    JOIN share_sessions ss ON ss.id=c.share_session_id JOIN shares sh ON sh.id=ss.share_id
    JOIN users owner ON owner.id=sh.owner_id JOIN control ctl ON ctl.singleton=1
    WHERE c.id=? AND c.kind='share' AND sh.id=? AND sh.kind IN ('link','upload_only')
      AND ss.revoked_at IS NULL AND ss.epoch=? AND ctl.epoch=ss.epoch AND ss.expires_at>strftime('%s','now')*1000
      AND ss.share_version=sh.version AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
      AND (ss.user_id IS NULL OR EXISTS(SELECT 1 FROM users WHERE id=ss.user_id AND disabled_at IS NULL))`)
    .bind(session.credentialId, session.shareId, session.epoch)
    .first();
  if (!found) throw new Error("csrf_rejected");
}

function sameOrigin(request: Request, origin: string, issue: boolean, kind: CsrfSession["kind"]) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:") throw new Error("invalid_csrf_origin");
  const supplied = request.headers.get("Origin");
  if (
    new URL(request.url).origin !== origin ||
    request.headers.get("Sec-Fetch-Site") !== "same-origin" ||
    (supplied !== origin && !(issue && kind === "access" && supplied === null))
  )
    throw new Error("csrf_rejected");
  if (issue) {
    if (request.method !== "POST") throw new Error("csrf_rejected");
  } else if (
    !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
  ) {
    throw new Error("csrf_rejected");
  }
}

function type(session: CsrfSession): string {
  return session.kind === "access" ? "csrf" : "public_csrf";
}
function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))),
  );
}

export class CsrfTokens {
  constructor(
    readonly privateRing: CsrfKeyRing,
    readonly publicRing: CsrfKeyRing,
    readonly origin: string,
    readonly now: () => number = Date.now,
  ) {}

  async issue(
    db: D1Database,
    request: Request,
    session: CsrfSession,
  ): Promise<{ token: string; expiresAt: number }> {
    sameOrigin(request, this.origin, true, session.kind);
    await liveSession(db, session);
    const ring = session.kind === "access" ? this.privateRing : this.publicRing;
    const key = ring.keys.get(ring.activeKid);
    if (!key) throw new Error("invalid_csrf_key_ring");
    const iat = Math.floor(this.now() / 1000);
    const payload = JSON.parse(
      canonical({
        aud: this.origin,
        credential_id: session.credentialId,
        epoch: session.epoch,
        exp: iat + 3600,
        iat,
        kid: ring.activeKid,
        nonce: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
        share_id: session.kind === "share" ? session.shareId : null,
        typ: type(session),
      }),
    );
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "ncf-csrf", kid: ring.activeKid })
      .sign(key);
    return { token, expiresAt: (iat + 3600) * 1000 };
  }

  /** Tokens are reusable for one hour; current credential validity is checked on every request. */
  async verify(db: D1Database, request: Request, session: CsrfSession): Promise<void> {
    try {
      sameOrigin(request, this.origin, false, session.kind);
      const token = request.headers.get("X-CSRF-Token");
      if (
        !token ||
        token.length > 4096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error("invalid_token");
      const ring = session.kind === "access" ? this.privateRing : this.publicRing;
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          if (
            Object.keys(header).some((field) => !["alg", "typ", "kid"].includes(field)) ||
            !header.kid
          )
            throw new Error("invalid_token");
          const key = ring.keys.get(header.kid);
          if (!key) throw new Error("unknown_key");
          return key;
        },
        {
          algorithms: ["HS256"],
          typ: "ncf-csrf",
          audience: this.origin,
          currentDate: new Date(this.now()),
          requiredClaims: ["iat", "exp", "epoch", "credential_id", "kid", "typ", "nonce"],
        },
      );
      if (
        payload.aud !== this.origin ||
        payload.typ !== type(session) ||
        payload.kid !== protectedHeader.kid ||
        payload.epoch !== session.epoch ||
        payload.credential_id !== session.credentialId ||
        payload.share_id !== (session.kind === "share" ? session.shareId : null) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.iat < 0 ||
        payload.iat > Math.floor(this.now() / 1000) ||
        payload.exp - payload.iat !== 3600 ||
        typeof payload.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce) ||
        Object.keys(payload).sort().join(",") !==
          "aud,credential_id,epoch,exp,iat,kid,nonce,share_id,typ" ||
        new TextDecoder().decode(base64url.decode(token.split(".")[1] ?? "")) !== canonical(payload)
      )
        throw new Error("invalid_token");
      await liveSession(db, session);
    } catch {
      throw new Error("csrf_rejected");
    }
  }
}
