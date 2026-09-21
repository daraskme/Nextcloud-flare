import type { Env } from "../env.js";

const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_AGE_SECONDS = 86_400;
const JWKS_FRESH_MS = 60 * 60 * 1000;
const JWKS_STALE_MS = 24 * 60 * 60 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;
const JWKS_MAX_KEYS = 16;
const REFRESH_LIMIT = 10;
const REFRESH_WINDOW_MS = 60_000;
const NEGATIVE_LIMIT = 64;

type AccessKind = "user" | "service";

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
  kid?: unknown;
}

interface JwtPayload {
  aud?: unknown;
  common_name?: unknown;
  email?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
  type?: unknown;
}

interface RsaJwk extends JsonWebKey {
  alg: "RS256";
  e: string;
  kid: string;
  kty: "RSA";
  n: string;
}

interface CachedJwks {
  fetchedAt: number;
  keys: RsaJwk[];
}

export interface VerifiedAccessClaims {
  issuer: string;
  issuedAt: number;
  expiresAt: number;
  notBefore?: number;
  subject?: string;
  email?: string;
  commonName?: string;
}

export interface AccessVerifierDependencies {
  fetcher?: typeof fetch;
  now?: () => number;
}

const refreshes = new Map<string, number[]>();
const inFlight = new Map<string, Promise<CachedJwks>>();
const negativeKids = new Map<string, number>();

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("invalid_token");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function parsePart(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function acceptsAudience(value: unknown, audience: string): boolean {
  return (
    value === audience || (Array.isArray(value) && value.length === 1 && value[0] === audience)
  );
}

function validateClaims(
  payload: JwtPayload,
  kind: AccessKind,
  issuer: string,
  audience: string,
  nowSeconds: number,
): VerifiedAccessClaims {
  if (
    payload.type !== "app" ||
    payload.iss !== issuer ||
    !acceptsAudience(payload.aud, audience) ||
    !isInteger(payload.iat) ||
    !isInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_AGE_SECONDS ||
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS
  ) {
    throw new Error("invalid_access_claims");
  }
  if (
    payload.nbf !== undefined &&
    (!isInteger(payload.nbf) || payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    throw new Error("invalid_access_claims");
  }
  if (kind === "user") {
    if (
      !isInteger(payload.nbf) ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.email !== "string" ||
      payload.email.length === 0
    ) {
      throw new Error("invalid_access_claims");
    }
    return {
      issuer,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      notBefore: payload.nbf,
      subject: payload.sub,
      email: payload.email,
    };
  }
  if (typeof payload.common_name !== "string" || payload.common_name.length === 0) {
    throw new Error("invalid_access_claims");
  }
  return {
    issuer,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(isInteger(payload.nbf) ? { notBefore: payload.nbf } : {}),
    commonName: payload.common_name,
  };
}

function validJwk(value: unknown): value is RsaJwk {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as Partial<RsaJwk>;
  return (
    key.kty === "RSA" &&
    key.alg === "RS256" &&
    typeof key.kid === "string" &&
    key.kid.length > 0 &&
    typeof key.n === "string" &&
    typeof key.e === "string" &&
    (key.use === undefined || key.use === "sig")
  );
}

async function cacheKey(issuer: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issuer));
  return `access-jwks:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) {
    throw new Error("jwks_unavailable");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > JWKS_MAX_BYTES) {
    throw new Error("jwks_too_large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    size += result.value.byteLength;
    if (size > JWKS_MAX_BYTES) {
      await reader.cancel();
      throw new Error("jwks_too_large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function consumeRefresh(issuer: string, now: number): void {
  const recent = (refreshes.get(issuer) ?? []).filter(
    (timestamp) => timestamp > now - REFRESH_WINDOW_MS,
  );
  if (recent.length >= REFRESH_LIMIT) {
    throw new Error("jwks_refresh_limited");
  }
  recent.push(now);
  refreshes.set(issuer, recent);
}

async function refreshJwks(
  env: Env,
  issuer: string,
  now: number,
  fetcher: typeof fetch,
): Promise<CachedJwks> {
  const existing = inFlight.get(issuer);
  if (existing !== undefined) {
    return existing;
  }
  consumeRefresh(issuer, now);
  const refresh = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
    try {
      const url = new URL("/cdn-cgi/access/certs", `${issuer.replace(/\/$/u, "")}/`);
      const parsed = await readBoundedJson(await fetcher(url, { signal: controller.signal }));
      const rawKeys =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { keys?: unknown }).keys
          : undefined;
      const keys = Array.isArray(rawKeys) ? rawKeys.filter(validJwk) : [];
      if (keys.length === 0 || keys.length > JWKS_MAX_KEYS) {
        throw new Error("invalid_jwks");
      }
      const cached = { fetchedAt: now, keys };
      await env.CACHE.put(await cacheKey(issuer), JSON.stringify(cached), {
        expirationTtl: JWKS_STALE_MS / 1000,
      });
      return cached;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(issuer);
    }
  })();
  inFlight.set(issuer, refresh);
  return refresh;
}

function rememberNegative(issuer: string, kid: string, now: number): void {
  negativeKids.set(`${issuer}|${kid}`, now + JWKS_FRESH_MS);
  while (negativeKids.size > NEGATIVE_LIMIT) {
    const first = negativeKids.keys().next().value;
    if (first === undefined) {
      break;
    }
    negativeKids.delete(first);
  }
}

async function resolveJwk(
  env: Env,
  issuer: string,
  kid: string,
  now: number,
  fetcher: typeof fetch,
): Promise<RsaJwk> {
  const key = await cacheKey(issuer);
  const cached = await env.CACHE.get<CachedJwks>(key, "json");
  const known = cached?.keys.find((candidate) => candidate.kid === kid);
  if (known !== undefined && cached !== null && now - cached.fetchedAt <= JWKS_FRESH_MS) {
    return known;
  }
  if ((negativeKids.get(`${issuer}|${kid}`) ?? 0) > now && cached !== null) {
    throw new Error("unknown_jwt_kid");
  }
  try {
    const refreshed = await refreshJwks(env, issuer, now, fetcher);
    const refreshedKey = refreshed.keys.find((candidate) => candidate.kid === kid);
    if (refreshedKey !== undefined) {
      negativeKids.delete(`${issuer}|${kid}`);
      return refreshedKey;
    }
  } catch (error) {
    if (known !== undefined && cached !== null && now - cached.fetchedAt <= JWKS_STALE_MS) {
      return known;
    }
    throw error;
  }
  rememberNegative(issuer, kid, now);
  throw new Error("unknown_jwt_kid");
}

export async function verifyAccessJwt(
  env: Env,
  token: string,
  kind: AccessKind,
  dependencies: AccessVerifierDependencies = {},
): Promise<VerifiedAccessClaims> {
  if (token.length === 0 || token.length > 16_384 || token.includes(",")) {
    throw new Error("invalid_access_token");
  }
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split(".");
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    extra !== undefined
  ) {
    throw new Error("invalid_access_token");
  }
  const header = parsePart(encodedHeader) as JwtHeader;
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0
  ) {
    throw new Error("invalid_access_header");
  }
  const now = dependencies.now?.() ?? Date.now();
  const issuer = env.ACCESS_ISSUER.replace(/\/$/u, "");
  const audience = kind === "user" ? env.ACCESS_USER_AUD : env.ACCESS_SERVICE_AUD;
  const claims = validateClaims(
    parsePart(encodedPayload) as JwtPayload,
    kind,
    issuer,
    audience,
    Math.floor(now / 1000),
  );
  const jwk = await resolveJwk(env, issuer, header.kid, now, dependencies.fetcher ?? fetch);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) {
    throw new Error("invalid_access_signature");
  }
  return claims;
}
