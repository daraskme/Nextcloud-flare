import { decryptChunk, type FileCipher, PLAIN_CHUNK_BYTES } from "./cryptoEnvelope";
import {
  authenticateContainerMetadata,
  type ContainerHeader,
  parseContainerHeader,
  planContainerPlainRange,
} from "./encryptedContainer";

const VIRTUAL_PREFIX = "/__client_media/";
const MAX_ENTRIES = 16;
const MAX_PER_CLIENT = 4;
const MAX_TTL_MS = 5 * 60_000;
const MAX_CIPHER_REQUEST = PLAIN_CHUNK_BYTES;
const MAX_CACHED_CHUNKS = 4;
const MAX_INFLIGHT_CHUNKS = 4;
const ETAG = /^"[A-Za-z0-9._:-]{1,200}"$/;
const TOKEN = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;
const INLINE_MIME =
  /^(?:image\/(?:avif|gif|jpeg|png|webp)|audio\/(?:mp4|mpeg|ogg|webm|wav)|video\/(?:mp4|ogg|webm)|application\/pdf)$/;

export interface ClientMediaRegistration {
  readonly headerBytes: Uint8Array;
  readonly cipher: FileCipher;
  readonly sourceUrl: string;
  readonly sourceEtag: string;
  readonly accountId: string;
  readonly expiresAt: number;
  readonly mode: "inline" | "download";
}

export type ClientMediaMessage =
  | { readonly kind: "ncf-client-media-register"; readonly input: ClientMediaRegistration }
  | { readonly kind: "ncf-client-media-clear" }
  | { readonly kind: "ncf-client-media-revoke"; readonly url: string }
  | { readonly kind: "ncf-client-media-renew"; readonly url: string; readonly expiresAt: number };
export type ClientMediaMessageResult =
  | { readonly ok: true; readonly url?: string }
  | { readonly ok: false };

interface Entry {
  readonly token: string;
  readonly clientId: string;
  readonly accountId: string;
  readonly sourceUrl: string;
  readonly sourceEtag: string;
  expiresAt: number;
  readonly mode: "inline" | "download";
  readonly header: ContainerHeader;
  readonly headerBytes: Uint8Array;
  readonly cipher: FileCipher;
  readonly mime: string;
  readonly name: string;
}

export interface ClientMediaWorkerOptions {
  readonly hostOrigin: string;
  readonly contentOrigin: string;
  readonly lookupClient: (id: string) => Promise<{ url: string } | undefined>;
  readonly lookupAccountId: () => Promise<string | undefined>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

export function privateMediaClient(urlValue: string, hostOrigin: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.origin !== hostOrigin || url.username || url.password || url.hash) return false;
    return /^\/(?:files(?:\/[A-Za-z0-9_-]+)?|gallery|audio|video|bookshelf|novels|encryption|admin\/files)\/?$/.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function sourceUrl(value: string, contentOrigin: string): string {
  const url = new URL(value);
  if (
    url.origin !== contentOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/c\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
  )
    throw new Error("invalid_source_url");
  return url.href;
}

/** Strict RFC 7233 single byte range. Malformed and multiple ranges are rejected. */
export function parseClientMediaRange(
  value: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (value === null) return { offset: 0, length: size };
  if (!Number.isSafeInteger(size) || size < 0 || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  if (first === null) {
    if (last === null || last === 0) return null;
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== null && last < first)) return null;
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  return { offset: first, length: end - first + 1 };
}

function noStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
}

function localError(status: number, size?: number): Response {
  const headers = noStoreHeaders();
  if (status === 416 && size !== undefined) headers.set("Content-Range", `bytes */${size}`);
  return new Response(null, { status, headers });
}

function validContentResponse(response: Response, url: string, etag: string): boolean {
  return (
    !response.redirected &&
    response.url === url &&
    response.headers.get("ETag") === etag &&
    (!response.headers.has("Content-Encoding") ||
      response.headers.get("Content-Encoding") === "identity")
  );
}

function disposition(entry: Entry): string {
  const type = entry.mode === "inline" && INLINE_MIME.test(entry.mime) ? "inline" : "attachment";
  const filename = encodeURIComponent(entry.name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename*=UTF-8''${filename}`;
}

export class ClientMediaWorker {
  private readonly entries = new Map<string, Entry>();
  // Only ciphertext is retained, in this Service Worker instance's memory. Keys
  // include the client and immutable source revision so registrations may share
  // one chunk without letting another client reuse it.
  private readonly cipherCache = new Map<string, { clientId: string; bytes: Uint8Array }>();
  private readonly inFlight = new Map<string, { clientId: string; promise: Promise<Uint8Array> }>();
  private cacheEpoch = 0;
  private activeFetches = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly hostOrigin: string;
  private readonly contentOrigin: string;

  constructor(private readonly options: ClientMediaWorkerOptions) {
    this.hostOrigin = new URL(options.hostOrigin).origin;
    this.contentOrigin = new URL(options.contentOrigin).origin;
    // Browser fetch requires its global receiver; a bare copy called as this.fetcher
    // can throw before a content-origin request is sent.
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  isVirtualRequest(request: Request): boolean {
    const url = new URL(request.url);
    return url.origin === this.hostOrigin && url.pathname.startsWith(VIRTUAL_PREFIX);
  }

  private async trustedClient(clientId: string): Promise<boolean> {
    if (!clientId) return false;
    const client = await this.options.lookupClient(clientId);
    return !!client && privateMediaClient(client.url, this.hostOrigin);
  }

  private async authorizedEntry(entry: Entry, clientId: string): Promise<boolean> {
    if (clientId !== entry.clientId) return false;
    if (this.entries.get(entry.token) !== entry) return false;
    try {
      if (
        (await this.trustedClient(clientId)) &&
        (await this.options.lookupAccountId()) === entry.accountId
      )
        return true;
    } catch {
      /* An unavailable account check revokes the token. */
    }
    this.entries.delete(entry.token);
    this.purgeClientCache(entry.clientId);
    return false;
  }

  private purgeClientCache(clientId: string): void {
    this.cacheEpoch++;
    for (const [key, cached] of this.cipherCache)
      if (cached.clientId === clientId) this.cipherCache.delete(key);
    for (const [key, pending] of this.inFlight)
      if (pending.clientId === clientId) this.inFlight.delete(key);
  }

  private removeEntry(entry: Entry): void {
    this.entries.delete(entry.token);
    this.purgeClientCache(entry.clientId);
  }

  private rememberCipherChunk(key: string, clientId: string, bytes: Uint8Array): void {
    this.cipherCache.delete(key);
    this.cipherCache.set(key, { clientId, bytes });
    while (this.cipherCache.size > MAX_CACHED_CHUNKS)
      this.cipherCache.delete(this.cipherCache.keys().next().value!);
  }

  private prune(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.removeEntry(entry);
  }

  clear(clientId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.clientId === clientId) this.entries.delete(key);
    this.purgeClientCache(clientId);
  }

  revoke(clientId: string, virtualUrl: string): void {
    const token = this.tokenFromUrl(virtualUrl);
    if (token && this.entries.get(token)?.clientId === clientId) {
      this.entries.delete(token);
      this.purgeClientCache(clientId);
    }
  }

  /** Renew only after a fresh same-source ticket has installed its content cookie. */
  async renew(clientId: string, virtualUrl: string, expiresAt: number): Promise<void> {
    const token = this.tokenFromUrl(virtualUrl);
    this.prune();
    const entry = token ? this.entries.get(token) : undefined;
    if (!entry) throw new Error("client_media_renew_rejected");
    try {
      if (
        entry.clientId !== clientId ||
        !(await this.trustedClient(clientId)) ||
        (await this.options.lookupAccountId()) !== entry.accountId ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= this.now() ||
        expiresAt > this.now() + MAX_TTL_MS
      )
        throw new Error("client_media_renew_rejected");
      if (!(await this.sourceStillValid(entry)) || entry.expiresAt <= this.now())
        throw new Error("client_media_renew_rejected");
      entry.expiresAt = expiresAt;
    } catch (error) {
      this.removeEntry(entry);
      throw error;
    }
  }

  /** The caller must pass MessageEvent.source.id, never an ID supplied in message data. */
  async handleMessage(clientId: string, value: unknown): Promise<ClientMediaMessageResult> {
    if (!value || typeof value !== "object" || !("kind" in value)) return { ok: false };
    const message = value as ClientMediaMessage;
    try {
      if (message.kind === "ncf-client-media-clear") {
        this.clear(clientId);
        return { ok: true };
      }
      if (message.kind === "ncf-client-media-revoke") {
        if (typeof message.url !== "string") return { ok: false };
        this.revoke(clientId, message.url);
        return { ok: true };
      }
      if (message.kind === "ncf-client-media-renew") {
        if (typeof message.url !== "string") return { ok: false };
        await this.renew(clientId, message.url, message.expiresAt);
        return { ok: true };
      }
      if (message.kind === "ncf-client-media-register") {
        const url = await this.register(clientId, message.input);
        return { ok: true, url };
      }
    } catch {
      return { ok: false };
    }
    return { ok: false };
  }

  private tokenFromUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (
        url.origin !== this.hostOrigin ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(VIRTUAL_PREFIX)
      )
        return null;
      const token = url.pathname.slice(VIRTUAL_PREFIX.length);
      return TOKEN.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  async register(clientId: string, input: ClientMediaRegistration): Promise<string> {
    if (
      !(await this.trustedClient(clientId)) ||
      !ACCOUNT.test(input.accountId) ||
      (await this.options.lookupAccountId()) !== input.accountId ||
      !ETAG.test(input.sourceEtag) ||
      !["inline", "download"].includes(input.mode) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.now() ||
      input.expiresAt > this.now() + MAX_TTL_MS ||
      !(input.headerBytes instanceof Uint8Array)
    )
      throw new Error("client_media_registration_rejected");
    const url = sourceUrl(input.sourceUrl, this.contentOrigin);
    const header = parseContainerHeader(input.headerBytes);
    const metadata = await authenticateContainerMetadata(header, input.cipher);
    // The first registration pins the actual header bytes. Another mode for
    // the same private client can reuse them only while that exact source
    // revision still authorizes an authenticated HEAD request.
    const pinned = [...this.entries.values()].find(
      (entry) =>
        entry.clientId === clientId &&
        entry.accountId === input.accountId &&
        entry.sourceUrl === url &&
        entry.sourceEtag === input.sourceEtag &&
        entry.header.totalBytes === header.totalBytes &&
        entry.expiresAt > this.now(),
    );
    if (pinned) {
      try {
        if (
          pinned.headerBytes.length !== input.headerBytes.length ||
          pinned.headerBytes.some((byte, index) => byte !== input.headerBytes[index]) ||
          !(await this.sourceStillValid(pinned)) ||
          this.entries.get(pinned.token) !== pinned
        )
          throw new Error("container_header_mismatch");
      } catch {
        this.removeEntry(pinned);
        throw new Error("container_header_mismatch");
      }
    } else {
      // The window's header is untrusted until matched against the immutable source revision.
      const found = await this.fetchExact(
        url,
        input.sourceEtag,
        header.totalBytes,
        0,
        header.headerEnd,
      );
      if (found.some((byte, index) => byte !== input.headerBytes[index]))
        throw new Error("container_header_mismatch");
    }
    if (
      !(await this.trustedClient(clientId)) ||
      (await this.options.lookupAccountId()) !== input.accountId
    )
      throw new Error("client_media_registration_rejected");
    this.prune();
    for (const [key, entry] of this.entries)
      if (entry.clientId === clientId && entry.accountId !== input.accountId)
        this.removeEntry(entry);
    const sameClient = [...this.entries.values()].filter((entry) => entry.clientId === clientId);
    if (sameClient.length >= MAX_PER_CLIENT) this.removeEntry(sameClient[0]!);
    if (this.entries.size >= MAX_ENTRIES) this.removeEntry(this.entries.values().next().value!);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.entries.set(token, {
      token,
      clientId,
      accountId: input.accountId,
      sourceUrl: url,
      sourceEtag: input.sourceEtag,
      expiresAt: input.expiresAt,
      mode: input.mode,
      header,
      headerBytes: new Uint8Array(input.headerBytes),
      cipher: input.cipher,
      mime: metadata.mime,
      name: metadata.name,
    });
    return `${this.hostOrigin}${VIRTUAL_PREFIX}${token}`;
  }

  private async fetchExact(
    url: string,
    etag: string,
    total: number,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_CIPHER_REQUEST ||
      offset < 0 ||
      offset + length > total
    )
      throw new Error("invalid_cipher_range");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        mode: "cors",
        signal: controller.signal,
      });
      if (
        response.status !== 206 ||
        !validContentResponse(response, url, etag) ||
        response.headers.get("Content-Range") !==
          `bytes ${offset}-${offset + length - 1}/${total}` ||
        (response.headers.has("Content-Length") &&
          response.headers.get("Content-Length") !== String(length)) ||
        !response.body
      )
        throw new Error("cipher_source_mismatch");
      const result = new Uint8Array(length);
      const reader = response.body.getReader();
      let used = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (used + next.value.length > length) throw new Error("cipher_source_overflow");
          result.set(next.value, used);
          used += next.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (used !== length) throw new Error("cipher_source_truncated");
      return result;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async sourceStillValid(entry: Entry): Promise<boolean> {
    const source = await this.fetcher(entry.sourceUrl, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      signal: AbortSignal.timeout(10_000),
    });
    return (
      source.status === 200 &&
      validContentResponse(source, entry.sourceUrl, entry.sourceEtag) &&
      source.headers.get("Content-Length") === String(entry.header.totalBytes)
    );
  }

  private chunkKey(entry: Entry, offset: number, length: number): string {
    return JSON.stringify([
      entry.clientId,
      entry.accountId,
      entry.sourceUrl,
      entry.sourceEtag,
      entry.header.totalBytes,
      offset,
      length,
    ]);
  }

  private async cachedCipherChunk(
    entry: Entry,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const key = this.chunkKey(entry, offset, length);
    const cached = this.cipherCache.get(key);
    const pending = this.inFlight.get(key);
    if (cached || pending) {
      const epoch = this.cacheEpoch;
      try {
        // A memory hit never grants ongoing access. The source ticket, revision,
        // authenticated account, and owning private client are checked again.
        if (!(await this.sourceStillValid(entry))) throw new Error("cipher_source_mismatch");
        if (
          epoch !== this.cacheEpoch ||
          entry.expiresAt <= this.now() ||
          !(await this.authorizedEntry(entry, entry.clientId))
        )
          throw new Error("client_media_expired");
        if (cached) {
          this.rememberCipherChunk(key, entry.clientId, cached.bytes);
          return cached.bytes;
        }
        return await pending!.promise;
      } catch (error) {
        this.removeEntry(entry);
        throw error;
      }
    }
    if (this.activeFetches >= MAX_INFLIGHT_CHUNKS) throw new Error("client_media_busy");
    const epoch = this.cacheEpoch;
    this.activeFetches++;
    const promise = this.fetchCipherChunk(entry, offset, length).then((bytes) => {
      if (
        epoch === this.cacheEpoch &&
        this.entries.get(entry.token) === entry &&
        entry.expiresAt > this.now()
      ) {
        this.rememberCipherChunk(key, entry.clientId, bytes);
      }
      return bytes;
    });
    this.inFlight.set(key, { clientId: entry.clientId, promise });
    try {
      return await promise;
    } finally {
      this.activeFetches--;
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  private async fetchCipherChunk(
    entry: Entry,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    for (let used = 0; used < length; used += MAX_CIPHER_REQUEST) {
      if (entry.expiresAt <= this.now()) throw new Error("client_media_expired");
      const count = Math.min(MAX_CIPHER_REQUEST, length - used);
      result.set(
        await this.fetchExact(
          entry.sourceUrl,
          entry.sourceEtag,
          entry.header.totalBytes,
          offset + used,
          count,
        ),
        used,
      );
    }
    return result;
  }

  async handleFetch(request: Request, clientId: string): Promise<Response> {
    if (!this.isVirtualRequest(request)) throw new Error("not_client_media_url");
    const token = this.tokenFromUrl(request.url);
    this.prune();
    const entry = token ? this.entries.get(token) : undefined;
    if (!entry || !clientId || !(await this.authorizedEntry(entry, clientId)))
      return localError(404);
    if (request.method !== "GET" && request.method !== "HEAD") return localError(405);
    const size = entry.header.envelope.plainSize;
    const rangeHeader = request.headers.get("Range");
    const range = parseClientMediaRange(rangeHeader, size);
    if (!range) return localError(416, size);
    const headers = noStoreHeaders();
    headers.set(
      "Content-Type",
      entry.mode === "inline" && INLINE_MIME.test(entry.mime)
        ? entry.mime
        : "application/octet-stream",
    );
    headers.set("Content-Disposition", disposition(entry));
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(range.length));
    const status = rangeHeader === null ? 200 : 206;
    if (status === 206)
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
      );
    if (request.method === "HEAD") {
      const source = await this.fetcher(entry.sourceUrl, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        mode: "cors",
      });
      if (
        source.status !== 200 ||
        !validContentResponse(source, entry.sourceUrl, entry.sourceEtag) ||
        source.headers.get("Content-Length") !== String(entry.header.totalBytes)
      )
        return localError(502);
      return new Response(null, { status, headers });
    }
    const worker = this;
    const iterator = planContainerPlainRange(entry.header, range.offset, range.length);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (entry.expiresAt <= worker.now() || !(await worker.authorizedEntry(entry, clientId)))
            throw new Error("client_media_expired");
          const next = iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          const part = next.value;
          const encoded = await worker.cachedCipherChunk(
            entry,
            part.cipherOffset,
            part.cipherLength,
          );
          let plain: Uint8Array;
          try {
            plain = await decryptChunk(entry.cipher, part.index, encoded);
          } catch (error) {
            worker.cipherCache.delete(worker.chunkKey(entry, part.cipherOffset, part.cipherLength));
            throw error;
          }
          if (entry.expiresAt <= worker.now() || !(await worker.authorizedEntry(entry, clientId)))
            throw new Error("client_media_expired");
          controller.enqueue(plain.subarray(part.takeOffset, part.takeOffset + part.takeLength));
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, { status, headers });
  }
}
