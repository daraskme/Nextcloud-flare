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
  result: { nodeId?: string; status?: number } | null;
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

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "接続を確認できませんでした。しばらくしてから再試行してください。";
  if (error.code === "commit_unknown")
    return "処理結果を確認中です。同じ操作のまま再確認してください。";
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
  children(id: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<Children>(
      `/api/v1/nodes/${encodeURIComponent(id)}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  path(id: string, signal?: AbortSignal) {
    return this.request<{ path: Breadcrumb[] }>(
      `/api/v1/nodes/${encodeURIComponent(id)}/path`,
      signal ? { signal } : {},
    );
  }
  trash(space: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<TrashPage>(
      `/api/v1/trash?spaceId=${encodeURIComponent(space)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }

  async openFile(account: Account, node: FileNode, target: Window): Promise<void> {
    const lifetime = this.#lifetime;
    try {
      const origin = new URL(account.contentOrigin);
      if (origin.protocol !== "https:" || origin.origin !== account.contentOrigin)
        throw new Error("invalid_content_origin");
      const issued = await this.json<{ ticket: string }>("/api/v1/content-session", "POST", {
        targets: [{ nodeId: node.id, spaceId: account.spaceId }],
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
export const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: exponent ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`;
};
