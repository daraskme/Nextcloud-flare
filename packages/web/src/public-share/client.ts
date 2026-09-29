import type { GalleryPage } from "../../../shared/src/gallery";
import { zipDownloadPath } from "../../../shared/src/zips";
import type { GalleryClient } from "./gallery";
import { galleryOriginal, largeThumbnailReady, readGalleryThumbnail } from "./galleryMedia";

export interface SharedNode {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  currentBlobId: string | null;
  size: number | null;
  revision: number;
}
export interface SharedRoot {
  kind?: "link";
  sessionId: string;
  permissions: {
    createFolder: boolean;
    rename: boolean;
    upload: boolean;
    overwrite: boolean;
    delete: boolean;
  };
  root: SharedNode;
  contentOrigin: string;
  expiresAt: number;
}
export interface UploadOnlyRoot {
  kind: "upload_only";
  sessionId: string;
  expiresAt: number;
  permissions: SharedRoot["permissions"];
}
export type PublicRoot = SharedRoot | UploadOnlyRoot;

/** Bind every opaque receipt to this request; never follow a server-supplied URL. */
export function uploadOnlyReceipt(
  shareId: string,
  path: string,
  value: unknown,
  status: number,
  capability: string | null,
) {
  const receipt = value as { receipt_id?: unknown; status_url?: unknown } | null;
  const prefix = `/api/v1/public/shares/${shareId}/uploads`;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Object.keys(receipt).length !== 2 ||
    typeof receipt.receipt_id !== "string" ||
    !/^up_[a-f0-9]{64}$/.test(receipt.receipt_id) ||
    receipt.status_url !== `${prefix}/${receipt.receipt_id}` ||
    (path !== prefix &&
      ![`${receipt.status_url}/complete`, `${receipt.status_url}/content`].includes(path) &&
      !new RegExp(`^${receipt.status_url}/parts/[1-9][0-9]{0,4}$`).test(path))
  )
    throw new Error("invalid_upload_receipt");
  const part = path.includes("/parts/");
  if (status !== 201 && !(part && status === 202)) throw new Error("invalid_upload_receipt");
  if (path === prefix) {
    if (!capability || !/^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(capability))
      throw new Error("invalid_upload_receipt");
    return { id: receipt.receipt_id, capability };
  }
  return part ? { disposition: status === 201 ? "completed" : "in_flight" } : receipt;
}
export interface SharedChildren {
  children: SharedNode[];
  nextCursor: string | null;
}
export class PublicError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter = 0,
    readonly operationId?: string,
  ) {
    super("public_request_failed");
  }
}
export class PublicClient {
  readonly lifetime = new AbortController();
  galleryClient(root: SharedRoot, nodeId: string): GalleryClient {
    const active = (signal: AbortSignal) =>
      AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30000)]);
    const headers = { "Share-Session": root.sessionId };
    const post = async <T>(body: unknown, signal: AbortSignal) => {
      const { token } = await this.request<{ token: string }>(
        "/csrf",
        "POST",
        undefined,
        undefined,
        headers,
        undefined,
        signal,
      );
      return this.request<T>("/content-session", "POST", body, token, headers, undefined, signal);
    };
    return {
      list: (recursive, cursor, signal) => {
        const query = new URLSearchParams({ nodeId, recursive: recursive ? "1" : "0" });
        if (cursor) query.set("cursor", cursor);
        return this.request<GalleryPage>(
          `/gallery?${query}`,
          "GET",
          undefined,
          undefined,
          headers,
          undefined,
          signal,
        );
      },
      prepare: async (items, signal) => {
        const receipt = await post<{ sessionId: string }>(
          {
            nodeIds: items.map((item) => item.id),
            purpose: "thumb",
            variant: "sm",
            delivery: "app",
            ttlSeconds: 600,
          },
          signal,
        );
        return (item, signal) =>
          readGalleryThumbnail(
            `/api/v1/public/shares/${this.id}/thumb/${item.id}?variant=sm`,
            { ...headers, "Content-Session": receipt.sessionId },
            active(signal),
          );
      },
      original: async (item, signal) => {
        const { ticket } = await post<{ ticket: string }>(
          { nodeIds: [item.id], ttlSeconds: 300 },
          signal,
        );
        return galleryOriginal(root.contentOrigin, ticket, item, active(signal));
      },
      preview: async (item, signal) => {
        const { token } = await this.request<{ token: string }>(
          "/csrf",
          "POST",
          undefined,
          undefined,
          headers,
          undefined,
          signal,
        );
        const receipt = await this.request<unknown>(
          `/thumb/${item.id}`,
          "POST",
          { blobId: item.currentBlobId, variant: "lg" },
          token,
          { ...headers, "Idempotency-Key": crypto.randomUUID() },
          undefined,
          signal,
        );
        if (!largeThumbnailReady(receipt, item)) return null;
        const session = await post<{ sessionId: string }>(
          { nodeIds: [item.id], purpose: "thumb", variant: "lg", delivery: "app", ttlSeconds: 600 },
          signal,
        );
        return readGalleryThumbnail(
          `/api/v1/public/shares/${this.id}/thumb/${item.id}?variant=lg`,
          { ...headers, "Content-Session": session.sessionId },
          active(signal),
        );
      },
    };
  }
  constructor(
    readonly id: string,
    private secret: string | null,
  ) {}
  close() {
    this.secret = null;
    this.lifetime.abort();
  }
  async request<T>(
    suffix: string,
    method = "GET",
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
    operationId?: string,
    signal?: AbortSignal,
    receipt = false,
  ): Promise<T> {
    const path = operationId
      ? `/api/v1/operations/${operationId}`
      : `/api/v1/public/shares/${this.id}${suffix}`;
    return this.#fetch<T>(
      path,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { "X-CSRF-Token": token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      signal,
      30000,
      receipt,
    );
  }
  async #fetch<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeout = 30000,
    receipt = false,
  ): Promise<T> {
    const active = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ]);
    active.throwIfAborted();
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: active,
    });
    if (!response.ok)
      throw new PublicError(
        response.status,
        Math.min(60, Math.max(1, Number(response.headers.get("Retry-After")) || 60)),
        /^op_[a-f0-9]{64}$/.test(response.headers.get("Operation-Id") ?? "")
          ? response.headers.get("Operation-Id")!
          : undefined,
      );
    const value = response.status === 204 ? undefined : await response.json();
    active.throwIfAborted();
    return (
      receipt
        ? uploadOnlyReceipt(
            this.id,
            path,
            value,
            response.status,
            response.headers.get("Upload-Capability"),
          )
        : value
    ) as T;
  }
  async uploadJson<T>(
    sessionId: string,
    suffix: string,
    method: "POST" | "DELETE",
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    receipt = false,
  ) {
    const { token } = await this.request<{ token: string }>(
      "/csrf",
      "POST",
      undefined,
      undefined,
      {},
      undefined,
      signal,
    );
    return this.request<T>(
      suffix,
      method,
      body,
      token,
      { ...headers, "Share-Session": sessionId },
      undefined,
      signal,
      receipt,
    );
  }
  uploadBytes<T>(
    suffix: string,
    body: Blob,
    headers: Record<string, string>,
    signal: AbortSignal,
    receipt = false,
  ) {
    return this.#fetch<T>(
      `/api/v1/public/shares/${this.id}${suffix}`,
      {
        method: "PUT",
        body,
        headers: { ...headers, "Content-Type": "application/octet-stream" },
      },
      signal,
      900000,
      receipt,
    );
  }
  async unlock(password: string) {
    if (!navigator.locks) throw new Error("locks_unavailable");
    await navigator.locks.request(
      `ncf-public-unlock:${this.id}`,
      { signal: this.lifetime.signal },
      async () => {
        const start = await this.request<{ unlocked?: boolean; token?: string }>(
          "/unlock",
          "POST",
          { step: "challenge" },
        );
        if (!start.unlocked) {
          if (!this.secret) throw new PublicError(410);
          await this.request(
            "/unlock",
            "POST",
            { secret: this.secret, ...(password ? { password } : {}) },
            start.token,
          );
        }
        this.secret = null;
      },
    );
    return this.request<PublicRoot>("");
  }
  children(id: string, cursor?: string | null) {
    return this.request<SharedChildren>(
      `/children/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
  }
  async mutate<T>(suffix: string, body: unknown) {
    const { token } = await this.request<{ token: string }>("/csrf", "POST");
    return this.request<T>(suffix, "POST", body, token);
  }
  async edit(intent: EditIntent, signal?: AbortSignal): Promise<EditOperation> {
    const { token } = await this.request<{ token: string }>(
      "/csrf",
      "POST",
      undefined,
      undefined,
      {},
      undefined,
      signal,
    );
    return this.request<EditOperation>(
      intent.suffix,
      intent.method,
      intent.body,
      token,
      {
        "Idempotency-Key": intent.key,
        "Share-Session": intent.sessionId,
      },
      undefined,
      signal,
    );
  }
  operation(id: string, sessionId: string, signal?: AbortSignal) {
    if (!/^op_[a-f0-9]{64}$/.test(id)) throw new Error("invalid_operation_id");
    return this.request<EditOperation>(
      "",
      "GET",
      undefined,
      undefined,
      {
        "X-Share-Id": this.id,
        "Share-Session": sessionId,
      },
      id,
      signal,
    );
  }
  async downloadZip(root: SharedRoot, nodeId: string, target: Window) {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)) throw new Error("invalid_zip_target");
      const { token } = await this.request<{ token: string }>("/csrf", "POST");
      const receipt = await this.request<unknown>(`/nodes/${nodeId}/zip`, "POST", {}, token, {
        "Share-Session": root.sessionId,
      });
      this.lifetime.signal.throwIfAborted();
      target.location.replace(
        new URL(zipDownloadPath(receipt, this.id), globalThis.location.origin).href,
      );
    } catch (error) {
      target.close();
      throw error;
    }
  }
  async download(root: SharedRoot, node: SharedNode, target: Window) {
    try {
      const origin = new URL(root.contentOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== root.contentOrigin ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(node.id) ||
        !node.currentBlobId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(node.currentBlobId)
      )
        throw new Error("invalid_content_target");
      const { ticket } = await this.mutate<{ ticket: string }>("/content-session", {
        nodeIds: [node.id],
        ttlSeconds: 300,
      });
      const response = await fetch(`${origin.origin}/session`, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) throw new PublicError(response.status);
      this.lifetime.signal.throwIfAborted();
      target.location.replace(`${origin.origin}/c/${node.id}/${node.currentBlobId}`);
    } catch (error) {
      target.close();
      throw error;
    }
  }
}

export interface EditIntent {
  key: string;
  sessionId: string;
  suffix: string;
  method: "POST" | "PATCH" | "DELETE";
  body: { name: string; kind?: "folder"; parentId?: string } | { revision: number };
}
export interface EditOperation {
  id: string;
  state: "claimed" | "committed" | "failed";
  result: { status: number; nodeId?: string } | null;
}
