export interface SharedNode {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  currentBlobId: string | null;
  size: number | null;
}
export interface SharedRoot {
  sessionId: string;
  permissions: { createFolder: boolean; rename: boolean };
  root: SharedNode;
  contentOrigin: string;
  expiresAt: number;
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
  ): Promise<T> {
    const path = operationId
      ? `/api/v1/operations/${operationId}`
      : `/api/v1/public/shares/${this.id}${suffix}`;
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)]),
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    this.lifetime.signal.throwIfAborted();
    return value as T;
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
    return this.request<SharedRoot>("");
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
  async edit(intent: EditIntent): Promise<EditOperation> {
    const { token } = await this.request<{ token: string }>("/csrf", "POST");
    return this.request<EditOperation>(intent.suffix, intent.method, intent.body, token, {
      "Idempotency-Key": intent.key,
      "Share-Session": intent.sessionId,
    });
  }
  operation(id: string, sessionId: string) {
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
    );
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
  method: "POST" | "PATCH";
  body: { name: string; kind?: "folder"; parentId?: string };
}
export interface EditOperation {
  id: string;
  state: "claimed" | "committed" | "failed";
  result: { status: number; nodeId?: string } | null;
}
