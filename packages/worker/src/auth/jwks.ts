import { createLocalJWKSet, type JSONWebKeySet } from "jose";

const FRESH_MS = 3_600_000;
const STALE_MS = 86_400_000;
const MAX_BYTES = 262_144;
interface CacheRecord {
  version: 1;
  issuer: string;
  fetchedAt: number;
  jwks: JSONWebKeySet;
}
export interface JwksCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}
export type JwksFetch = (url: string, init: RequestInit) => Promise<Response>;

export function accessIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new Error("invalid_access_issuer");
  return value;
}

function keys(value: unknown): JSONWebKeySet {
  if (!value || typeof value !== "object" || !("keys" in value) || !Array.isArray(value.keys))
    throw new Error("invalid_jwks");
  if (value.keys.length < 1 || value.keys.length > 16) throw new Error("invalid_jwks");
  const seen = new Set<string>();
  return {
    keys: value.keys.map((key) => {
      if (
        !key ||
        typeof key !== "object" ||
        key.kty !== "RSA" ||
        typeof key.kid !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(key.kid) ||
        seen.has(key.kid) ||
        (key.alg !== undefined && key.alg !== "RS256") ||
        (key.use !== undefined && key.use !== "sig") ||
        (key.key_ops !== undefined &&
          (!Array.isArray(key.key_ops) ||
            key.key_ops.length !== 1 ||
            key.key_ops[0] !== "verify")) ||
        typeof key.n !== "string" ||
        !/^[A-Za-z0-9_-]{342,1366}$/.test(key.n) ||
        typeof key.e !== "string" ||
        !/^[A-Za-z0-9_-]{1,8}$/.test(key.e) ||
        ["d", "p", "q", "dp", "dq", "qi", "oth"].some((field) => field in key)
      )
        throw new Error("invalid_jwks");
      seen.add(key.kid);
      return { kty: "RSA", kid: key.kid, n: key.n, e: key.e, alg: "RS256", use: "sig" };
    }),
  };
}

/** One long-lived instance per fixed issuer/isolate. KV is a key cache, never an auth decision. */
export class AccessJwks {
  readonly issuer: string;
  readonly #cacheKey: string;
  readonly #cache: JwksCache;
  readonly #fetch: JwksFetch;
  readonly #now: () => number;
  #record: CacheRecord | undefined;
  #resolver: ReturnType<typeof createLocalJWKSet> | undefined;
  #load: Promise<void> | undefined;
  #flight: Promise<void> | undefined;
  #refreshes: number[] = [];
  #negative = new Map<string, number>();

  constructor(issuer: string, cache: JwksCache, fetcher: JwksFetch = fetch, now = Date.now) {
    this.issuer = accessIssuer(issuer);
    this.#cacheKey = `access-jwks:v1:${issuer}`;
    this.#cache = cache;
    this.#fetch = fetcher;
    this.#now = now;
  }

  #install(record: CacheRecord) {
    this.#record = record;
    this.#resolver = createLocalJWKSet(record.jwks);
  }

  async #loadCache() {
    try {
      const raw = await this.#cache.get(this.#cacheKey);
      if (!raw || raw.length > MAX_BYTES) return;
      const record = JSON.parse(raw) as CacheRecord;
      const age = this.#now() - record.fetchedAt;
      if (
        record.version !== 1 ||
        record.issuer !== this.issuer ||
        !Number.isSafeInteger(record.fetchedAt) ||
        age < 0 ||
        age >= STALE_MS
      )
        return;
      this.#install({ ...record, jwks: keys(record.jwks) });
    } catch {
      /* A corrupt/unavailable hint must fall back to the pinned issuer. */
    }
  }

  async #download() {
    const now = this.#now();
    this.#refreshes = this.#refreshes.filter((at) => now - at < 60_000);
    if (this.#refreshes.length >= 10) throw new Error("jwks_refresh_limited");
    this.#refreshes.push(now);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("jwks_timeout"));
      }, 5000);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([
        this.#fetch(`${this.issuer}/cdn-cgi/access/certs`, {
          redirect: "error",
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) > MAX_BYTES
      ) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new Error("jwks_unavailable");
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) throw new Error("jwks_too_large");
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const jwks = keys(
        JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)),
      );
      const record: CacheRecord = { version: 1, issuer: this.issuer, fetchedAt: this.#now(), jwks };
      this.#install(record);
      for (const key of jwks.keys) if (key.kid) this.#negative.delete(key.kid);
      // A failed cache write cannot invalidate a successfully fetched signing key.
      await Promise.race([
        this.#cache.put(this.#cacheKey, JSON.stringify(record), { expirationTtl: STALE_MS / 1000 }),
        timeout,
      ]).catch(() => {});
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  async resolver(kid: string): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!/^[\x21-\x7e]{1,256}$/.test(kid)) throw new Error("invalid_kid");
    await (this.#load ??= this.#loadCache());
    const known = this.#record?.jwks.keys.some((key) => key.kid === kid);
    const age = this.#record ? this.#now() - this.#record.fetchedAt : Infinity;
    if (known && age >= 0 && age < FRESH_MS && this.#resolver) return this.#resolver;
    if (!known && (this.#negative.get(kid) ?? 0) > this.#now()) throw new Error("unknown_kid");
    try {
      await (this.#flight ??= this.#download().finally(() => {
        this.#flight = undefined;
      }));
    } catch (error) {
      const fallbackAge = this.#record ? this.#now() - this.#record.fetchedAt : Infinity;
      if (known && fallbackAge >= 0 && fallbackAge < STALE_MS && this.#resolver)
        return this.#resolver;
      throw error;
    }
    if (!this.#record?.jwks.keys.some((key) => key.kid === kid) || !this.#resolver) {
      for (const [key, until] of this.#negative)
        if (until <= this.#now()) this.#negative.delete(key);
      if (this.#negative.size >= 64) {
        const oldest = this.#negative.keys().next().value;
        if (oldest !== undefined) this.#negative.delete(oldest);
      }
      this.#negative.set(kid, this.#now() + 60_000);
      throw new Error("unknown_kid");
    }
    return this.#resolver;
  }
}
