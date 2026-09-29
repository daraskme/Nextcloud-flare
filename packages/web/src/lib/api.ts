import type { AudioPage, PlaybackState } from "../../../shared/src/audio";
import type { CopyJobStatus } from "../../../shared/src/copyJobs";
import type { DeadLetterPage, DeadLetterRequeue } from "../../../shared/src/deadLetters";
import type { GalleryPage } from "../../../shared/src/gallery";
import type { ArchiveBook, PageReadingState } from "../../../shared/src/library";
import type { InternalShare, SelectedShare } from "../../../shared/src/shares";
import { zipDownloadPath, zipFailureMessage } from "../../../shared/src/zips";
import { type AudioClient, audioOriginal } from "../public-share/audioClient";
import type { BookClient } from "../public-share/bookClient";
import type { GalleryClient } from "../public-share/gallery";
import {
  galleryOriginal,
  largeThumbnailReady,
  readGalleryThumbnail,
} from "../public-share/galleryMedia";

export interface Account {
  id: string;
  email: string;
  role: string;
  spaceId: string;
  rootNodeId: string;
  epoch: number;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  contentOrigin: string;
}
export interface FileNode {
  id: string;
  parentId?: string;
  name: string;
  kind: "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
  size: number | null;
  mime: string | null;
}
export interface Children {
  parentId: string;
  treeGeneration: number;
  children: FileNode[];
  nextCursor: string | null;
}
export interface SearchPage {
  scopeId: string;
  query: string;
  treeGeneration: number;
  items: FileNode[];
  nextCursor: string | null;
  truncated: boolean;
}
export interface FolderStats {
  scopeId: string;
  treeGeneration: number;
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  scannedNodes: number;
  nodeLimit: number;
  unavailableFiles: number;
  truncated: boolean;
}
export interface Breadcrumb {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
}
export interface TrashItem {
  opId: string;
  rootNodeId: string;
  name: string;
  kind: "folder" | "file";
  deletedAt: number;
  memberCount: number;
}
export interface TrashPage {
  items: TrashItem[];
  treeGeneration: number;
  nextCursor: string | null;
}
export interface Operation {
  id: string;
  state: "claimed" | "committed" | "failed";
  result: { nodeId?: string; jobId?: string; status?: number } | null;
  errorCode?: string;
}
export interface Part {
  partNumber: number;
  attempts: number;
  attemptId: string | null;
  state: "pending" | "in_flight" | "completed" | "unknown";
  expectedBytes: number;
}
export interface UploadReceipt {
  id: string;
  mode: "single" | "multipart";
  state: string;
  declaredSize: number;
  expiresAt: number;
  cleanupPending: boolean;
  operationId: string | null;
  errorCode: string | null;
  partBytes?: number;
  partCount?: number;
  parts?: Part[];
  nextAfter?: number | null;
  revision?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly operationId: string | null = null,
  ) {
    super(code);
  }
}

export function zipErrorMessage(error: unknown): string {
  return (
    (error instanceof ApiError ? zipFailureMessage(error.status) : undefined) ?? errorMessage(error)
  );
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "接続を確認できませんでした。しばらくしてから再試行してください。";
  if (error.code === "copy_tracking_unavailable")
    return "コピー状況を保存できません。ブラウザーの保存設定を確認し、同じ操作の結果を確認してください。";
  if (error.code === "copy_tracking_full")
    return "コピー状況の保存上限です。完了した項目の表示を閉じてから、同じ操作の結果を確認してください。";
  if (error.code === "copy_retry_cleanup_pending")
    return "前のコピーの容量精算を待っています。精算が終わると再試行できます。";
  if (error.code === "gc_quiescing")
    return "削除処理の完了を待っています。少し待ってから同じ操作を再確認してください。";
  if (error.code === "blob_unrecoverable")
    return "削除が進行済みのデータを含むため、この項目は復元できません。";
  if (error.code === "commit_unknown")
    return "処理結果を確認中です。同じ操作のまま再確認してください。";
  if (error.code === "share_recipient_unavailable")
    return "共有相手を確認できません。登録済みのメールアドレスを指定してください。自分自身には共有できません。";
  if (error.status === 401) return "ログインの有効期限が切れました。もう一度ログインしてください。";
  if (error.status === 403) return "この操作の権限、またはセッションの有効期限を確認してください。";
  if (error.status === 404)
    return "項目が見つからないか、アクセスできません。一覧を更新してください。";
  if (error.status === 409 || error.status === 412)
    return "同じ名前の項目、または別の操作による変更があります。一覧を更新して確認してください。";
  if (error.status === 413 || error.status === 507)
    return "ファイルサイズまたはストレージの上限を超えています。";
  if (error.status === 429) return "処理が混み合っています。少し待ってから再試行してください。";
  if (error.status === 503)
    return "現在サービスを利用できません。データを保持して再接続を待っています。";
  return "操作を完了できませんでした。入力内容を確認してください。";
}

export class ApiClient {
  #csrf: { token: string; until: number } | undefined;
  #csrfFlight: Promise<string> | undefined;
  #lifetime = new AbortController();

  async extractMedia(
    node: Pick<FileNode, "id" | "currentBlobId">,
    key: string,
    signal: AbortSignal,
    share?: SelectedShare,
  ) {
    const lifetime = this.#lifetime;
    const token = await this.csrf();
    const active = AbortSignal.any([signal, lifetime.signal]);
    active.throwIfAborted();
    return this.request<unknown>(`/api/v1/nodes/${node.id}/media`, {
      method: "POST",
      signal: active,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ blobId: node.currentBlobId, ...(share ? { share } : {}) }),
    });
  }

  audioClient(
    account: Account,
    rootId: string,
    share?: SelectedShare & { spaceId: string },
  ): AudioClient {
    const lifetime = this.#lifetime;
    const active = (signal: AbortSignal) =>
      AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30000)]);
    const selection = share ? { id: share.id, version: share.version } : undefined;
    const list = (id: string, cursor: string | null, signal: AbortSignal) => {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      if (share) {
        query.set("shareId", share.id);
        query.set("shareVersion", String(share.version));
      }
      return this.request<AudioPage>(`/api/v1/nodes/${id}/tracks${query.size ? `?${query}` : ""}`, {
        signal: active(signal),
      });
    };
    const post = async <T>(path: string, method: string, body: unknown, signal: AbortSignal) => {
      const token = await this.csrf();
      active(signal).throwIfAborted();
      return this.request<T>(path, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
        signal: active(signal),
      });
    };
    return {
      scope: JSON.stringify([account.id, account.epoch, rootId, share?.id, share?.version]),
      signal: lifetime.signal,
      list: (cursor, signal) => list(rootId, cursor, signal),
      current: (id, signal) => list(id, null, signal),
      prepareCovers: this.galleryClient(account, rootId, share).prepare,
      requestCover: async (item, key, signal) => {
        const token = await this.csrf();
        active(signal).throwIfAborted();
        return this.request(`/api/v1/nodes/${item.id}/thumb`, {
          method: "POST",
          signal: active(signal),
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            blobId: item.currentBlobId,
            variant: "sm",
            ...(selection ? { share: selection } : {}),
          }),
        });
      },
      original: async (item, signal) => {
        const { ticket } = await post<{ ticket: string }>(
          "/api/v1/content-session",
          "POST",
          {
            purpose: "content",
            ttlSeconds: 300,
            targets: [{ nodeId: item.id, spaceId: share?.spaceId ?? account.spaceId }],
            ...(selection ? { share: selection } : {}),
          },
          signal,
        );
        return audioOriginal(account.contentOrigin, ticket, item, active(signal));
      },
      edit: async (id, key, update, signal) => {
        const token = await this.csrf();
        active(signal).throwIfAborted();
        return this.request(`/api/v1/nodes/${id}/audio`, {
          method: "PATCH",
          signal: active(signal),
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ ...update, ...(selection ? { share: selection } : {}) }),
        });
      },
      save: (item, generator, positionMs, previousUpdatedAt, signal) =>
        post<PlaybackState>(
          `/api/v1/nodes/${item.id}/playback-state`,
          "PUT",
          {
            blobId: item.currentBlobId,
            generator,
            positionMs,
            previousUpdatedAt,
            ...(selection ? { share: selection } : {}),
          },
          signal,
        ),
    };
  }

  bookClient(
    account: Account,
    node: FileNode,
    share?: SelectedShare & { spaceId: string },
  ): BookClient {
    const lifetime = this.#lifetime;
    const active = (signal: AbortSignal) =>
      AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30000)]);
    const query = new URLSearchParams();
    if (share) {
      query.set("shareId", share.id);
      query.set("shareVersion", String(share.version));
    }
    return {
      contentOrigin: account.contentOrigin,
      blobId: node.currentBlobId ?? "",
      nodeId: node.id,
      lifetime: lifetime.signal,
      book: (signal) =>
        this.request<ArchiveBook>(`/api/v1/library/${node.id}${query.size ? "?" + query : ""}`, {
          signal: active(signal),
        }),
      save: async (update, signal) => {
        const token = await this.csrf();
        active(signal).throwIfAborted();
        return this.request<PageReadingState>(`/api/v1/library/${node.id}/reading-state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({
            ...update,
            ...(share ? { share: { id: share.id, version: share.version } } : {}),
          }),
          signal: active(signal),
        });
      },
      ticket: async (signal) => {
        const token = await this.csrf();
        active(signal).throwIfAborted();
        return this.request<{ ticket: string }>("/api/v1/content-session", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({
            purpose: "page",
            ttlSeconds: 600,
            targets: [{ nodeId: node.id, spaceId: share?.spaceId ?? account.spaceId }],
            ...(share ? { share: { id: share.id, version: share.version } } : {}),
          }),
          signal: active(signal),
        });
      },
    };
  }

  galleryClient(
    account: Account,
    rootId: string,
    share?: SelectedShare & { spaceId: string },
  ): GalleryClient {
    const lifetime = this.#lifetime;
    const active = (signal: AbortSignal) =>
      AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30000)]);
    const selection = share ? { id: share.id, version: share.version } : undefined;
    const post = async <T>(body: unknown, signal: AbortSignal) => {
      const token = await this.csrf();
      active(signal).throwIfAborted();
      return this.request<T>("/api/v1/content-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
        signal: active(signal),
      });
    };
    return {
      list: (recursive, cursor, signal) => {
        const query = new URLSearchParams({ recursive: recursive ? "1" : "0" });
        if (cursor) query.set("cursor", cursor);
        if (share) {
          query.set("shareId", share.id);
          query.set("shareVersion", String(share.version));
        }
        return this.request<GalleryPage>(`/api/v1/nodes/${rootId}/gallery?${query}`, {
          signal: active(signal),
        });
      },
      prepare: async (items, signal) => {
        const receipt = await post<{ sessionId: string }>(
          {
            purpose: "thumb",
            delivery: "app",
            ttlSeconds: 600,
            targets: items.map((item) => ({
              nodeId: item.id,
              spaceId: share?.spaceId ?? account.spaceId,
              variant: "sm",
            })),
            ...(selection ? { share: selection } : {}),
          },
          signal,
        );
        return (item, signal) =>
          readGalleryThumbnail(
            `/api/v1/nodes/${item.id}/thumb?variant=sm`,
            { "Content-Session": receipt.sessionId },
            active(signal),
          );
      },
      original: async (item, signal) => {
        const { ticket } = await post<{ ticket: string }>(
          {
            purpose: "content",
            ttlSeconds: 300,
            targets: [{ nodeId: item.id, spaceId: share?.spaceId ?? account.spaceId }],
            ...(selection ? { share: selection } : {}),
          },
          signal,
        );
        return galleryOriginal(account.contentOrigin, ticket, item, active(signal));
      },
      preview: async (item, signal) => {
        const token = await this.csrf();
        active(signal).throwIfAborted();
        const receipt = await this.request<unknown>(`/api/v1/nodes/${item.id}/thumb`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            blobId: item.currentBlobId,
            variant: "lg",
            ...(selection ? { share: selection } : {}),
          }),
          signal: active(signal),
        });
        if (!largeThumbnailReady(receipt, item)) return null;
        const session = await post<{ sessionId: string }>(
          {
            purpose: "thumb",
            delivery: "app",
            ttlSeconds: 600,
            targets: [
              { nodeId: item.id, spaceId: share?.spaceId ?? account.spaceId, variant: "lg" },
            ],
            ...(selection ? { share: selection } : {}),
          },
          signal,
        );
        return readGalleryThumbnail(
          `/api/v1/nodes/${item.id}/thumb?variant=lg`,
          { "Content-Session": session.sessionId },
          active(signal),
        );
      },
    };
  }

  clear() {
    this.#lifetime.abort();
    this.#lifetime = new AbortController();
    this.#csrf = undefined;
    this.#csrfFlight = undefined;
  }

  async request<T>(path: string, init: RequestInit = {}, timeout = 30_000): Promise<T> {
    if (!path.startsWith("/api/v1/")) throw new Error("invalid_api_path");
    const lifetime = this.#lifetime;
    const signals = [lifetime.signal, AbortSignal.timeout(timeout)];
    if (init.signal) signals.push(init.signal);
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    lifetime.signal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.#csrf = undefined;
      throw new ApiError(
        response.status,
        typeof value?.title === "string" ? value.title : "request_failed",
        response.headers.get("Operation-Id"),
      );
    }
    if (value === null) throw new Error("invalid_api_response");
    return value as T;
  }

  async csrf(): Promise<string> {
    if (this.#csrf && this.#csrf.until > Date.now()) return this.#csrf.token;
    if (!this.#csrfFlight) {
      const lifetime = this.#lifetime;
      const flight = this.request<{ token: string }>("/api/v1/csrf", { method: "POST" })
        .then(({ token }) => {
          lifetime.signal.throwIfAborted();
          this.#csrf = { token, until: Date.now() + 4 * 60_000 };
          return token;
        })
        .finally(() => {
          if (this.#csrfFlight === flight) this.#csrfFlight = undefined;
        });
      this.#csrfFlight = flight;
    }
    return this.#csrfFlight;
  }

  async json<T>(
    path: string,
    method: string,
    body: unknown,
    key?: string,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const lifetime = this.#lifetime;
    const token = await this.csrf();
    lifetime.signal.throwIfAborted();
    return this.request<T>(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        ...(key ? { "Idempotency-Key": key } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }

  /** Retains the same idempotency key across network uncertainty. Never turns uncertainty into a second mutation. */
  async mutation(path: string, method: string, body: unknown, key: string): Promise<Operation> {
    let operation: Operation;
    try {
      operation = await this.json<Operation>(path, method, body, key);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.operationId) throw error;
      operation = await this.request<Operation>(
        `/api/v1/operations/${encodeURIComponent(error.operationId)}`,
      );
    }
    if (operation.state === "claimed") throw new ApiError(503, "commit_unknown", operation.id);
    if (operation.state !== "committed") throw new ApiError(409, "conflict", operation.id);
    return operation;
  }

  me(signal?: AbortSignal) {
    return this.request<Account>("/api/v1/me", signal ? { signal } : {});
  }
  deadLetters(cursor: string | null, signal?: AbortSignal) {
    return this.request<DeadLetterPage>(
      `/api/v1/admin/dlq${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  requeueDeadLetter(outboxId: string, messageId: string) {
    // The immutable observation identifies the entire intent, including after reload.
    return this.json<DeadLetterRequeue>(
      `/api/v1/admin/dlq/${encodeURIComponent(outboxId)}/requeue`,
      "POST",
      { messageId },
      `dlq:${messageId}`,
    );
  }
  copyJob(id: string, signal?: AbortSignal) {
    return this.request<CopyJobStatus>(
      `/api/v1/jobs/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
  }
  cancelCopyJob(id: string) {
    return this.json<CopyJobStatus>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, "POST", {});
  }
  retryCopyJob(id: string, key: string) {
    return this.mutation(`/api/v1/jobs/${encodeURIComponent(id)}/retry`, "POST", {}, key);
  }
  sharedWithMe(cursor?: string | null, signal?: AbortSignal) {
    return this.request<{ items: InternalShare[]; nextCursor: string | null }>(
      `/api/v1/shared-with-me${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  share(id: string, signal?: AbortSignal) {
    return this.request<InternalShare>(
      `/api/v1/shares/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
  }
  node(id: string, share?: SelectedShare, signal?: AbortSignal) {
    return this.request<
      Omit<FileNode, "kind" | "parentId"> & {
        kind: "root" | "folder" | "file";
        parentId: string | null;
        spaceId: string;
        ownerId: string;
      }
    >(`/api/v1/nodes/${encodeURIComponent(id)}${shareQuery(share)}`, signal ? { signal } : {});
  }
  children(id: string, cursor?: string | null, signal?: AbortSignal, share?: SelectedShare) {
    const params = new URLSearchParams(shareQuery(share));
    if (cursor) params.set("cursor", cursor);
    return this.request<Children>(
      `/api/v1/nodes/${encodeURIComponent(id)}/children${params.size ? `?${params}` : ""}`,
      signal ? { signal } : {},
    );
  }
  search(scopeId: string, q: string, cursor?: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ scopeId, q });
    if (cursor) params.set("cursor", cursor);
    return this.request<SearchPage>(`/api/v1/search?${params}`, signal ? { signal } : {});
  }
  stats(scopeId: string, signal?: AbortSignal) {
    return this.request<FolderStats>(
      `/api/v1/stats?scopeId=${encodeURIComponent(scopeId)}`,
      signal ? { signal } : {},
    );
  }
  path(id: string, signal?: AbortSignal, share?: SelectedShare) {
    return this.request<{ path: Breadcrumb[] }>(
      `/api/v1/nodes/${encodeURIComponent(id)}/path${shareQuery(share)}`,
      signal ? { signal } : {},
    );
  }
  trash(space: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<TrashPage>(
      `/api/v1/trash?spaceId=${encodeURIComponent(space)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }

  async openFile(
    account: Account,
    node: FileNode,
    target: Window,
    shared?: { spaceId: string; share: SelectedShare },
  ): Promise<void> {
    const lifetime = this.#lifetime;
    try {
      const origin = new URL(account.contentOrigin);
      if (origin.protocol !== "https:" || origin.origin !== account.contentOrigin)
        throw new Error("invalid_content_origin");
      const issued = await this.json<{ ticket: string }>("/api/v1/content-session", "POST", {
        targets: [{ nodeId: node.id, spaceId: shared?.spaceId ?? account.spaceId }],
        ...(shared ? { share: shared.share } : {}),
        purpose: "content",
        ttlSeconds: 300,
      });
      lifetime.signal.throwIfAborted();
      const accepted = await fetch(`${origin.origin}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
      });
      lifetime.signal.throwIfAborted();
      if (!accepted.ok) throw new ApiError(accepted.status, "content_session_failed");
      target.location.replace(
        `${origin.origin}/c/${encodeURIComponent(node.id)}/${encodeURIComponent(node.currentBlobId ?? "")}`,
      );
    } catch (error) {
      target.close();
      throw error;
    }
  }

  async downloadZip(nodeId: string, target: Window, share?: SelectedShare): Promise<void> {
    const lifetime = this.#lifetime;
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)) throw new Error("invalid_zip_target");
      const receipt = await this.json<unknown>(
        `/api/v1/nodes/${nodeId}/zip`,
        "POST",
        share ? { share } : {},
      );
      lifetime.signal.throwIfAborted();
      const path = zipDownloadPath(receipt);
      target.location.replace(new URL(path, globalThis.location.origin).href);
    } catch (error) {
      target.close();
      throw error;
    }
  }

  async logout(): Promise<void> {
    const response = await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": await this.csrf() },
      credentials: "same-origin",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.type !== "opaqueredirect" && response.status !== 303)
      throw new ApiError(response.status, "logout_failed");
  }
}

export const api = new ApiClient();
function shareQuery(share?: SelectedShare) {
  return share
    ? `?${new URLSearchParams({ shareId: share.id, shareVersion: String(share.version) })}`
    : "";
}
export const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: exponent ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`;
};
