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
  clientEncryptionRequired?: boolean;
}
export interface EncryptionRegisteredKey {
  accountId: string;
  recipient: { fingerprint: string; spki: string };
  signer: { fingerprint: string; spki: string };
  registeredAt: number;
}
export interface EncryptionFileMarker {
  formatVersion: 1 | 2;
  headerSha256: string;
  cryptoId: string;
  ownerId: string;
  signerFingerprint: string;
  signerRsaFingerprint: string;
  requiredAdminFingerprint: string;
  adminReceiptState: "pending" | "verified";
  legacyAttestation: boolean;
  ownerSignature: string | null;
  attestedNodeId?: string | null;
  attestedRevision?: number | null;
  adminReceiptSignature?: string | null;
  adminAccountId?: string | null;
  adminVerifiedAt?: number | null;
}
export interface EncryptionKeyChallenge {
  id: string;
  ciphertext: string;
  expiresAt: number;
}
export interface AdminFileUser {
  id: string;
  email: string;
  spaceId: string;
  rootNodeId: string;
  quotaBytes: number;
  usedBytes: number;
  disabled: boolean;
}
export interface AdminAuditEvent {
  id: string;
  actorId: string;
  ownerId: string;
  nodeId: string;
  action: string;
  occurredAt: number;
}
export interface FileNode {
  id: string;
  parentId?: string;
  ownerId?: string;
  name: string;
  kind: "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
  size: number | null;
  mime: string | null;
  starred?: boolean;
  lastOpenedAt?: number | null;
  encryption?: EncryptionFileMarker | null;
}
export interface UserNodePage {
  kind: "recent" | "starred";
  items: FileNode[];
  nextCursor: string | null;
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
export interface GalleryItem {
  id: string;
  name: string;
  currentBlobId: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  takenAt: number | null;
  updatedAt: number;
  thumbnail: "ready" | "pending" | "failed";
}
export interface GalleryPage {
  rootId: string;
  treeGeneration: number;
  recursive: boolean;
  items: GalleryItem[];
  nextCursor: string | null;
  truncated: boolean;
  candidateLimit: number;
}
export interface AudioTrack {
  id: string;
  name: string;
  currentBlobId: string;
  mime: string;
  durationMs: number | null;
  codec: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
}
export interface AudioPage {
  rootId: string;
  treeGeneration: number;
  recursive: boolean;
  items: AudioTrack[];
  nextCursor: string | null;
  limitReached: boolean;
  trackLimit: number;
}
export interface LibraryPublication {
  nodeId: string;
  blobId: string;
  title: string | null;
  author: string | null;
  series: string | null;
  pageCount: number;
  coverToken: string | null;
  spine: string[];
  entries: {
    token: string;
    path: string;
    mime: string;
    size: number;
  }[];
  ticketPurpose: "page";
  contentBaseUrl: string;
}
export interface PlaybackState {
  nodeId: string;
  blobId: string;
  durationMs: number;
  positionMs: number | null;
  updatedAt: number | null;
}
export interface AudioChapter {
  id: string;
  positionMs: number;
  title: string;
}
export interface AudioChapterSet {
  nodeId: string;
  blobId: string;
  durationMs: number;
  revision: number;
  chapters: AudioChapter[];
}
export interface ReadingState {
  nodeId: string;
  blobId: string;
  pageCount: number;
  position: {
    spineIndex: number;
    progress: number;
  } | null;
  updatedAt: number | null;
}
export interface FileCandidates {
  items: FileNode[];
  truncated: boolean;
}
export type ContentPurpose = "content" | "thumb" | "page" | "track";
export interface PreparedContentSession {
  ticketId: string;
  url(target: { id: string; currentBlobId: string }, entryToken?: string): string;
  cancel(): Promise<void>;
}
export interface PreparedZipSession {
  ticketId: string;
  targetSetId: string;
  expiresAt: number;
  downloadUrl: string;
  cancel(): Promise<void>;
}
export interface Operation {
  id: string;
  state: "claimed" | "committed" | "failed";
  result: { nodeId?: string; status?: number } | null;
  errorCode?: string;
  job?: { state: "pending" | "running" | "completed" | "failed" | "cancelled" };
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
export interface LinkShare {
  id: string;
  rootNodeId: string | null;
  rootName: string | null;
  kind: "link" | "upload_only";
  version: number;
  disabledAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  passwordProtected: boolean;
  reservedBytes: number;
  reservationLimit: number;
  actions: readonly string[];
}
export interface CreatedLinkShare extends LinkShare {
  secret: string;
  shareUrl: string;
}
export type InternalShareAction = "read" | "download" | "create" | "edit";
export interface InternalShareResharePolicy {
  enabled: boolean;
  actions: readonly InternalShareAction[];
  maxDepth: number;
  maxFanout: number;
  expiresAt: number | null;
  version: number;
}
export interface InternalShareResharePolicyInput {
  enabled: boolean;
  actions: readonly InternalShareAction[];
  maxDepth: number;
  maxFanout: number;
  ttlDays?: number;
}
export interface InternalShare {
  id: string;
  rootNodeId: string;
  rootName: string | null;
  kind: "internal";
  version: number;
  disabledAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  passwordProtected: false;
  actions: readonly InternalShareAction[];
  recipientUserId: string | null;
  recipientEmail: string | null;
  recipientGroupId: string | null;
  recipientGroupName: string | null;
  mountId: string;
  mountName: string | null;
  sourceShareId: string | null;
  delegatedByUserId: string | null;
  delegationDepth: number;
  resharePolicy: InternalShareResharePolicy | null;
}
export type OwnedShare = LinkShare | InternalShare;
export interface ShareGroup {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  memberEmails: readonly string[];
}
export interface SharedMount {
  shareId: string;
  shareVersion: number;
  mountId: string;
  mountName: string;
  actions: readonly InternalShareAction[];
  expiresAt: number | null;
  delegationDepth: number;
  reshareAuthority: {
    policyVersion: number;
    actions: readonly InternalShareAction[];
    maxDepth: number;
    maxFanout: number;
    currentFanout: number;
    expiresAt: number | null;
  } | null;
  root: {
    id: string;
    spaceId: string;
    ownerId: string;
    name: string;
    kind: "folder";
    revision: number;
  };
  owner: { id: string; email: string };
  provenance:
    | { kind: "direct"; recipientVersion: number }
    | {
        kind: "group";
        groupId: string;
        groupName: string;
        groupVersion: number;
        membershipVersion: number;
      };
}
export type AppPasswordScope = "node:read" | "node:create" | "node:write" | "node:delete";
export interface AppPassword {
  id: string;
  credentialId: string;
  name: string;
  rootNodeId: string | null;
  createdAt: number;
  expiresAt: number;
  scopes: AppPasswordScope[];
}

export interface AdminInvite {
  id: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  claimedAt: number | null;
  claimedUserId: string | null;
}

export type CreatedAdminInvite = Pick<AdminInvite, "id" | "email" | "createdAt" | "expiresAt">;
export interface CreatedAppPassword extends AppPassword {
  secret: string;
}
export interface CreateAppPasswordInput {
  name: string;
  scopes: readonly AppPasswordScope[];
  ttlDays: number;
  spaceId?: string;
  rootNodeId?: string;
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
  if (error.code === "payload_too_large")
    return "このフォルダーはZIPの項目数またはサイズ上限を超えています。内容を分けて再試行してください。";
  if (error.code === "unsupported_media_type")
    return "このフォルダーにはZIPで扱えない名前または構成が含まれています。";
  if (error.code === "zip_stale")
    return "準備中にフォルダー、共有、またはファイルの版が変更されました。一覧を更新して再試行してください。";
  if (error.code === "zip_expired")
    return "ZIPのダウンロード期限が切れました。もう一度準備してください。";
  if (error.code === "budget_exceeded")
    return "ダウンロード上限に達しました。しばらく待ってから再試行してください。";
  if (error.code === "gc_quiescing")
    return "削除処理の完了を待っています。少し待ってから同じ操作を再確認してください。";
  if (error.code === "blob_unrecoverable")
    return "削除が進行済みのデータを含むため、この項目は復元できません。";
  if (error.code === "commit_unknown")
    return "処理結果を確認中です。同じ操作のまま再確認してください。";
  if (error.code === "mutation_rejected")
    return "関連する処理やデータの状態により操作を完了できませんでした。時間をおいて再試行してください。";
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
    if (response.status === 204) return undefined as T;
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
    signal?: AbortSignal,
  ): Promise<T> {
    const lifetime = this.#lifetime;
    const token = await this.csrf();
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    return this.request<T>(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        ...(key ? { "Idempotency-Key": key } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
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
    for (
      let attempt = 0;
      operation.state === "claimed" && operation.job && attempt < 30;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      operation = await this.request<Operation>(
        `/api/v1/operations/${encodeURIComponent(operation.id)}`,
      );
    }
    if (operation.state === "claimed") throw new ApiError(503, "commit_unknown", operation.id);
    if (operation.state !== "committed")
      throw new ApiError(409, operation.errorCode ?? "conflict", operation.id);
    return operation;
  }

  me(signal?: AbortSignal) {
    return this.request<Account>("/api/v1/me", signal ? { signal } : {});
  }
  encryptionAdminKeys(signal?: AbortSignal) {
    return this.request<{ keys: EncryptionRegisteredKey[] }>(
      "/api/v1/encryption/admin-keys",
      signal ? { signal } : {},
    );
  }
  encryptionKeys(accountId: string, signal?: AbortSignal) {
    return this.request<{ keys: EncryptionRegisteredKey[] }>(
      `/api/v1/encryption/keys/${encodeURIComponent(accountId)}`,
      signal ? { signal } : {},
    );
  }
  createEncryptionKeyChallenge(
    recipient: EncryptionRegisteredKey["recipient"],
    signer: EncryptionRegisteredKey["signer"],
    signal?: AbortSignal,
  ) {
    return this.json<EncryptionKeyChallenge>(
      "/api/v1/encryption/keys/challenge",
      "POST",
      { recipient, signer },
      undefined,
      {},
      signal,
    );
  }
  registerEncryptionKey(
    challengeId: string,
    secret: string,
    signature: string,
    signal?: AbortSignal,
  ) {
    return this.json<EncryptionRegisteredKey>(
      "/api/v1/encryption/keys/register",
      "POST",
      { challengeId, secret, signature },
      undefined,
      {},
      signal,
    );
  }
  adoptLegacyEncryptedNode(
    nodeId: string,
    input: {
      blobId: string;
      revision: number;
      headerSha256: string;
      ownerSignature: string;
      requiredAdminFingerprint: string;
    },
  ) {
    return this.json<{ encryption: EncryptionFileMarker }>(
      `/api/v1/encryption/nodes/${encodeURIComponent(nodeId)}/adopt`,
      "POST",
      input,
    );
  }
  recordAdminEncryptionReceipt(blobId: string, headerSha256: string, signature: string) {
    return this.json<{ encryption: EncryptionFileMarker }>(
      `/api/v1/encryption/blobs/${encodeURIComponent(blobId)}/admin-receipt`,
      "POST",
      { headerSha256, signature },
    );
  }
  adminUsers(cursor?: string | null, signal?: AbortSignal) {
    return this.request<{ users: AdminFileUser[]; nextCursor: string | null }>(
      `/api/v1/admin/users${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  adminChildren(userId: string, nodeId: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<Children>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/nodes/${encodeURIComponent(nodeId)}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  adminPath(userId: string, nodeId: string, signal?: AbortSignal) {
    return this.request<{ path: Breadcrumb[] }>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/nodes/${encodeURIComponent(nodeId)}/path`,
      signal ? { signal } : {},
    );
  }
  adminAudit(cursor?: string | null, signal?: AbortSignal) {
    return this.request<{ events: AdminAuditEvent[]; nextCursor: string | null }>(
      `/api/v1/admin/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  async prepareAdminContentSession(
    user: AdminFileUser,
    node: Pick<FileNode, "id" | "currentBlobId">,
    action: "preview" | "download",
    account: Account,
    signal?: AbortSignal,
  ): Promise<PreparedContentSession> {
    if (!node.currentBlobId) throw new Error("content_not_available");
    const origin = new URL(account.contentOrigin);
    if (origin.protocol !== "https:" || origin.origin !== account.contentOrigin)
      throw new Error("invalid_content_origin");
    const issued = await this.json<{ ticket: string; ticketId: string }>(
      `/api/v1/admin/users/${encodeURIComponent(user.id)}/content-session`,
      "POST",
      {
        targets: [{ nodeId: node.id, spaceId: user.spaceId }],
        purpose: "content",
        action,
        ttlSeconds: 300,
      },
      undefined,
      {},
      signal,
    );
    try {
      const accepted = await fetch(`${origin.origin}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          this.#lifetime.signal,
          AbortSignal.timeout(30_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!accepted.ok) throw new ApiError(accepted.status, "content_session_failed");
      let cancelled = false;
      return {
        ticketId: issued.ticketId,
        url: (target) =>
          `${origin.origin}/c/${encodeURIComponent(target.id)}/${encodeURIComponent(target.currentBlobId)}`,
        cancel: async () => {
          if (cancelled) return;
          cancelled = true;
          try {
            await this.cancelTicket(issued.ticketId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
        },
      };
    } catch (error) {
      void this.cancelTicket(issued.ticketId).catch(() => undefined);
      throw error;
    }
  }
  children(id: string, cursor?: string | null, signal?: AbortSignal) {
    return this.request<Children>(
      `/api/v1/nodes/${encodeURIComponent(id)}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  search(
    scopeId: string,
    q: string,
    cursor?: string | null,
    signal?: AbortSignal,
    mode: "name" | "audio" = "name",
  ) {
    const params = new URLSearchParams({ scopeId, q });
    if (cursor) params.set("cursor", cursor);
    if (mode === "audio") params.set("mode", "audio");
    return this.request<SearchPage>(`/api/v1/search?${params}`, signal ? { signal } : {});
  }
  userNodes(kind: "recent" | "starred", cursor?: string | null, signal?: AbortSignal) {
    return this.request<UserNodePage>(
      `/api/v1/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal ? { signal } : {},
    );
  }
  setStar(nodeId: string, starred: boolean) {
    return this.json<{ starred: boolean }>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/star`,
      "PUT",
      { starred },
    );
  }
  recordRecent(nodeId: string) {
    return this.json<{ recorded: boolean }>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/recent`,
      "PUT",
      {},
    );
  }
  stats(scopeId: string, signal?: AbortSignal) {
    return this.request<FolderStats>(
      `/api/v1/stats?scopeId=${encodeURIComponent(scopeId)}`,
      signal ? { signal } : {},
    );
  }
  shares(signal?: AbortSignal) {
    return this.request<{ shares: OwnedShare[] }>("/api/v1/shares", signal ? { signal } : {});
  }
  sharedWithMe(signal?: AbortSignal) {
    return this.request<{ shares: SharedMount[] }>(
      "/api/v1/shared-with-me",
      signal ? { signal } : {},
    );
  }
  groups(signal?: AbortSignal) {
    return this.request<{ groups: ShareGroup[] }>("/api/v1/groups", signal ? { signal } : {});
  }
  appPasswords(signal?: AbortSignal) {
    return this.request<{ passwords: AppPassword[] }>(
      "/api/v1/app-passwords",
      signal ? { signal } : {},
    );
  }
  createAppPassword(input: CreateAppPasswordInput, signal?: AbortSignal) {
    return this.json<CreatedAppPassword>(
      "/api/v1/app-passwords",
      "POST",
      input,
      undefined,
      {},
      signal,
    );
  }
  async revokeAppPassword(credentialId: string, signal?: AbortSignal): Promise<void> {
    const lifetime = this.#lifetime;
    const token = await this.csrf();
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    await this.request(`/api/v1/app-passwords/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      ...(signal ? { signal } : {}),
    });
  }
  adminInvites(signal?: AbortSignal) {
    return this.request<{ invites: AdminInvite[] }>(
      "/api/v1/admin/invites",
      signal ? { signal } : {},
    );
  }
  createAdminInvite(email: string, signal?: AbortSignal) {
    return this.json<CreatedAdminInvite>(
      "/api/v1/admin/invites",
      "POST",
      { email },
      undefined,
      {},
      signal,
    );
  }
  async revokeAdminInvite(id: string, signal?: AbortSignal): Promise<void> {
    const lifetime = this.#lifetime;
    const token = await this.csrf();
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    await this.request(`/api/v1/admin/invites/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      ...(signal ? { signal } : {}),
    });
  }
  createGroup(name: string, memberEmails: readonly string[]) {
    return this.json<ShareGroup>("/api/v1/groups", "POST", { name, memberEmails });
  }
  updateGroup(groupId: string, input: { name?: string; memberEmails?: readonly string[] }) {
    return this.json<ShareGroup>(`/api/v1/groups/${encodeURIComponent(groupId)}`, "PATCH", input);
  }
  async disableGroup(groupId: string): Promise<void> {
    const token = await this.csrf();
    await this.request(`/api/v1/groups/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
    });
  }
  createShare(
    rootNodeId: string,
    spaceId: string,
    ttlDays: number,
    kind: "link" | "upload_only",
    password?: string,
    reservationLimitBytes?: number,
  ) {
    return this.json<CreatedLinkShare>("/api/v1/shares", "POST", {
      rootNodeId,
      spaceId,
      kind,
      ttlDays,
      ...(password ? { password } : {}),
      ...(reservationLimitBytes === undefined ? {} : { reservationLimitBytes }),
    });
  }
  async disableShare(shareId: string): Promise<void> {
    const token = await this.csrf();
    await this.request(`/api/v1/shares/${encodeURIComponent(shareId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
    });
  }
  createInternalShare(
    rootNodeId: string,
    spaceId: string,
    recipient: { email: string } | { groupId: string },
    actions: readonly InternalShareAction[],
    ttlDays: number,
    resharePolicy?: InternalShareResharePolicyInput,
  ) {
    return this.json<InternalShare>("/api/v1/shares", "POST", {
      kind: "internal",
      rootNodeId,
      spaceId,
      ...("email" in recipient
        ? { recipientEmail: recipient.email }
        : { recipientGroupId: recipient.groupId }),
      actions,
      ttlDays,
      ...(resharePolicy === undefined ? {} : { resharePolicy }),
    });
  }
  createInternalReshare(
    source: Pick<SharedMount, "shareId" | "root">,
    recipient: { email: string } | { groupId: string },
    actions: readonly InternalShareAction[],
    ttlDays: number,
    idempotencyKey: string,
  ) {
    return this.json<InternalShare>(
      "/api/v1/shares",
      "POST",
      {
        kind: "internal",
        sourceShareId: source.shareId,
        rootNodeId: source.root.id,
        spaceId: source.root.spaceId,
        ...("email" in recipient
          ? { recipientEmail: recipient.email }
          : { recipientGroupId: recipient.groupId }),
        actions,
        ttlDays,
      },
      idempotencyKey,
    );
  }
  updateInternalShare(
    shareId: string,
    input: {
      actions?: readonly InternalShareAction[];
      resharePolicy?: InternalShareResharePolicyInput;
    },
  ) {
    return this.json<InternalShare>(
      `/api/v1/shares/${encodeURIComponent(shareId)}`,
      "PATCH",
      input,
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
  gallery(rootId: string, cursor?: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ recursive: "1" });
    if (cursor) params.set("cursor", cursor);
    return this.request<GalleryPage>(
      `/api/v1/nodes/${encodeURIComponent(rootId)}/gallery?${params}`,
      signal ? { signal } : {},
    );
  }
  tracks(rootId: string, cursor?: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ recursive: "1" });
    if (cursor) params.set("cursor", cursor);
    return this.request<AudioPage>(
      `/api/v1/nodes/${encodeURIComponent(rootId)}/tracks?${params}`,
      signal ? { signal } : {},
    );
  }

  library(nodeId: string, signal?: AbortSignal) {
    return this.request<LibraryPublication>(
      `/api/v1/library/${encodeURIComponent(nodeId)}`,
      signal ? { signal } : {},
    );
  }

  playbackState(nodeId: string, signal?: AbortSignal) {
    return this.request<PlaybackState>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/playback-state`,
      signal ? { signal } : {},
    );
  }

  writePlaybackState(nodeId: string, blobId: string, positionMs: number) {
    return this.json<PlaybackState>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/playback-state`,
      "PUT",
      { blobId, positionMs },
    );
  }

  audioChapters(nodeId: string, signal?: AbortSignal) {
    return this.request<AudioChapterSet>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/audio-chapters`,
      signal ? { signal } : {},
    );
  }

  writeAudioChapters(
    nodeId: string,
    blobId: string,
    expectedRevision: number,
    chapters: readonly AudioChapter[],
    signal?: AbortSignal,
  ) {
    return this.json<AudioChapterSet>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/audio-chapters`,
      "PUT",
      { blobId, expectedRevision, chapters },
      undefined,
      {},
      signal,
    );
  }

  readingState(nodeId: string, signal?: AbortSignal) {
    return this.request<ReadingState>(
      `/api/v1/library/${encodeURIComponent(nodeId)}/reading-state`,
      signal ? { signal } : {},
    );
  }

  writeReadingState(nodeId: string, blobId: string, spineIndex: number, progress: number) {
    return this.json<ReadingState>(
      `/api/v1/library/${encodeURIComponent(nodeId)}/reading-state`,
      "PUT",
      { blobId, spineIndex, progress },
    );
  }

  async filesByExtensions(
    rootId: string,
    extensions: readonly string[],
    signal?: AbortSignal,
  ): Promise<FileCandidates> {
    const pages = await Promise.all(
      extensions.map((extension) => this.search(rootId, `.${extension}`, null, signal)),
    );
    const selected = new Map<string, FileNode>();
    const accepted = new Set(extensions.map((extension) => extension.toLowerCase()));
    for (const page of pages)
      for (const item of page.items) {
        const extension = item.name.split(".").at(-1)?.toLowerCase();
        if (item.kind === "file" && extension && accepted.has(extension))
          selected.set(item.id, item);
      }
    return {
      items: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name, "ja")),
      truncated: pages.some((page) => page.truncated || page.nextCursor !== null),
    };
  }

  async cancelTicket(ticketId: string, signal?: AbortSignal): Promise<void> {
    const token = await this.csrf();
    signal?.throwIfAborted();
    await this.request(`/api/v1/tickets/${encodeURIComponent(ticketId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      ...(signal ? { signal } : {}),
    });
  }

  async prepareContentSession(
    account: Account,
    targets: readonly { id: string; currentBlobId: string }[],
    purpose: ContentPurpose,
    signal?: AbortSignal,
  ): Promise<PreparedContentSession> {
    if (!targets.length || targets.length > 1_000) throw new Error("invalid_content_targets");
    const lifetime = this.#lifetime;
    const origin = new URL(account.contentOrigin);
    if (origin.protocol !== "https:" || origin.origin !== account.contentOrigin)
      throw new Error("invalid_content_origin");
    let issued: { ticket: string; ticketId: string } | undefined;
    try {
      issued = await this.json<{ ticket: string; ticketId: string }>(
        "/api/v1/content-session",
        "POST",
        {
          targets: targets.map((target) => ({ nodeId: target.id, spaceId: account.spaceId })),
          purpose,
          ttlSeconds: 300,
        },
      );
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      const signals = [lifetime.signal, AbortSignal.timeout(30_000)];
      if (signal) signals.push(signal);
      const accepted = await fetch(`${origin.origin}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!accepted.ok) throw new ApiError(accepted.status, "content_session_failed");
      let cancelled = false;
      return {
        ticketId: issued.ticketId,
        url: (target, entryToken) => {
          const base = `${origin.origin}/c/${encodeURIComponent(target.id)}/${encodeURIComponent(target.currentBlobId)}`;
          if (purpose === "thumb") return `${base}/thumb`;
          if (purpose === "track") return `${base}/track`;
          if (purpose === "page") {
            if (!entryToken) throw new Error("missing_epub_entry");
            return `${base}/entries/${encodeURIComponent(entryToken)}`;
          }
          return base;
        },
        cancel: async () => {
          if (cancelled) return;
          cancelled = true;
          try {
            await this.cancelTicket(issued!.ticketId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
        },
      };
    } catch (error) {
      if (issued) void this.cancelTicket(issued.ticketId).catch(() => undefined);
      throw error;
    }
  }

  async prepareZip(
    account: Account,
    nodeId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PreparedZipSession> {
    const lifetime = this.#lifetime;
    const origin = new URL(account.contentOrigin);
    if (origin.protocol !== "https:" || origin.origin !== account.contentOrigin)
      throw new Error("invalid_content_origin");
    let issued:
      | {
          ticket: string;
          ticketId: string;
          targetSetId: string;
          expiresAt: number;
        }
      | undefined;
    try {
      const publication = await this.json<{
        ticket: string;
        ticketId: string;
        targetSetId: string;
        expiresAt: number;
      }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/zip`, "POST", {}, idempotencyKey, {}, signal);
      issued = publication;
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      const signals = [lifetime.signal, AbortSignal.timeout(30_000)];
      if (signal) signals.push(signal);
      const requestSignal = AbortSignal.any(signals);
      const accepted = await fetch(`${origin.origin}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: publication.ticket }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: requestSignal,
      });
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!accepted.ok)
        throw new ApiError(
          accepted.status,
          accepted.status === 401 || accepted.status === 404
            ? "zip_stale"
            : "content_session_failed",
        );
      const checked = await fetch(
        `${origin.origin}/z/${encodeURIComponent(publication.targetSetId)}`,
        {
          method: "HEAD",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          signal: requestSignal,
        },
      );
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!checked.ok)
        throw new ApiError(
          checked.status,
          checked.status === 429
            ? "budget_exceeded"
            : checked.status === 404
              ? Date.now() >= publication.expiresAt
                ? "zip_expired"
                : "zip_stale"
              : "request_failed",
        );
      let cancelled = false;
      return {
        ticketId: publication.ticketId,
        targetSetId: publication.targetSetId,
        expiresAt: publication.expiresAt,
        downloadUrl: `/api/v1/zips/${encodeURIComponent(publication.targetSetId)}`,
        cancel: async () => {
          if (cancelled) return;
          cancelled = true;
          try {
            await this.cancelTicket(publication.ticketId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
        },
      };
    } catch (error) {
      const stale =
        error instanceof ApiError && (error.code === "zip_stale" || error.code === "zip_expired");
      if (issued && (stale || signal?.aborted || lifetime.signal.aborted))
        void this.cancelTicket(issued.ticketId).catch(() => undefined);
      throw error;
    }
  }

  async prepareContent(
    account: Account,
    targets: readonly { id: string; currentBlobId: string }[],
    purpose: Exclude<ContentPurpose, "page">,
    signal?: AbortSignal,
  ): Promise<(target: { id: string; currentBlobId: string }) => string> {
    const session = await this.prepareContentSession(account, targets, purpose, signal);
    return (target) => session.url(target);
  }

  async openFile(account: Account, node: FileNode, target: Window): Promise<void> {
    try {
      if (!node.currentBlobId) throw new Error("content_not_available");
      const contentUrl = await this.prepareContent(
        account,
        [{ id: node.id, currentBlobId: node.currentBlobId }],
        "content",
      );
      target.location.replace(contentUrl({ id: node.id, currentBlobId: node.currentBlobId }));
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
