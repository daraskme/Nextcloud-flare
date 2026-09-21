import type {
  AppPasswordSummary,
  AudioAlbum,
  BreadcrumbItem,
  CreatedAppPassword,
  ChildrenPage,
  GalleryPage,
  LibraryItemSummary,
  LibraryRootSummary,
  NodeSummary,
  ReadingPosition,
  EpubEntrySummary,
  NodeVersionSummary,
  ShareKind,
  ShareMode,
  ShareSummary,
  SharedMount,
  TrashPage,
  UploadInfo,
  UploadMode,
} from "@ncf/shared";

interface MeResponse {
  user: { id: string; email: string; role: "member" | "app_admin" };
  workspace: { rootId: string; spaceId: string; treeGeneration: number };
}

let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly existingNodeId: string | undefined;
  readonly revision: number | undefined;

  constructor(
    status: number,
    error: { code?: string; message?: string; existingNodeId?: string; revision?: number },
  ) {
    super(error.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = error.code ?? "request_failed";
    this.existingNodeId = error.existingNodeId;
    this.revision = error.revision;
  }
}

async function responseError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: {
      code?: string;
      message?: string;
      existingNodeId?: string;
      revision?: number;
    };
  } | null;
  return new ApiError(response.status, body?.error ?? {});
}

async function csrf(): Promise<string> {
  if (csrfToken !== null) {
    return csrfToken;
  }
  const response = await fetch("/api/v1/csrf", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  const body = (await response.json()) as { token: string };
  csrfToken = body.token;
  return body.token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("X-CSRF-Token", await csrf());
    headers.set("Sec-Fetch-Site", "same-origin");
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    if (response.status === 403) {
      csrfToken = null;
    }
    throw await responseError(response);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  me: () => request<MeResponse>("/api/v1/me"),
  children: (nodeId: string, cursor?: string) =>
    request<ChildrenPage>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/children${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    ),
  path: (nodeId: string) =>
    request<{ items: BreadcrumbItem[] }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/path`),
  createFolder: (parentId: string, name: string) =>
    request<NodeSummary>("/api/v1/nodes", {
      method: "POST",
      body: JSON.stringify({ parentId, name }),
    }),
  rename: (nodeId: string, name: string) =>
    request<NodeSummary>(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  move: (nodeId: string, destinationParentId: string) =>
    request<NodeSummary>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationParentId }),
    }),
  copy: (nodeId: string, destinationParentId: string, name?: string) =>
    request<NodeSummary>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/copy`, {
      method: "POST",
      body: JSON.stringify({ destinationParentId, name }),
    }),
  versions: (nodeId: string) =>
    request<{ items: NodeVersionSummary[] }>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/versions`,
    ),
  restoreVersion: (nodeId: string, versionId: string, expectedRevision: number) =>
    request<NodeSummary>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    ),
  createUpload: (parentId: string, name: string, declaredSize: number, mode: UploadMode) =>
    request<UploadInfo>("/api/v1/uploads", {
      method: "POST",
      body: JSON.stringify({ parentId, name, declaredSize, mode }),
    }),
  uploadStatus: (uploadId: string, capability: string) =>
    request<UploadInfo>(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      headers: { "Upload-Capability": capability },
    }),
  putSingle: (uploadId: string, capability: string, body: Blob) =>
    request<UploadInfo>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/content`, {
      method: "PUT",
      headers: { "Upload-Capability": capability },
      body,
    }),
  putPart: (uploadId: string, capability: string, partNumber: number, body: Blob) =>
    request<{ partNumber: number; size: number; etag: string }>(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: { "Upload-Capability": capability },
        body,
      },
    ),
  completeUpload: (
    uploadId: string,
    capability: string,
    options?: { mode: "overwrite"; expectedRevision: number } | { mode: "rename" },
  ) => {
    const query =
      options === undefined
        ? ""
        : options.mode === "overwrite"
          ? `?mode=overwrite&expectedRevision=${options.expectedRevision}`
          : "?mode=rename";
    return request<NodeSummary>(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete${query}`,
      {
        method: "POST",
        headers: { "Upload-Capability": capability },
      },
    );
  },
  abortUpload: (uploadId: string, capability: string) =>
    request<undefined>(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: { "Upload-Capability": capability },
    }),
  search: (rootId: string, query: string, signal?: AbortSignal) =>
    request<{ items: NodeSummary[]; truncated: boolean }>(
      `/api/v1/search?root=${encodeURIComponent(rootId)}&q=${encodeURIComponent(query)}`,
      signal === undefined ? undefined : { signal },
    ),
  stats: () =>
    request<{
      quotaBytes: number;
      usedBytes: number;
      physicalBytes: number;
      reservedBytes: number;
      files: number;
      folders: number;
      logicalBytes: number;
      truncated: boolean;
    }>("/api/v1/stats"),
  gallery: (rootId: string, recursive: boolean, cursor?: string) =>
    request<GalleryPage>(
      `/api/v1/nodes/${encodeURIComponent(rootId)}/gallery?recursive=${recursive}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    ),
  tracks: (folderId: string) =>
    request<AudioAlbum>(`/api/v1/nodes/${encodeURIComponent(folderId)}/tracks`),
  savePlaybackState: (nodeId: string, positionMs: number) =>
    request<undefined>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/playback-state`, {
      method: "PUT",
      body: JSON.stringify({ positionMs }),
    }),
  libraryItems: () => request<{ items: LibraryItemSummary[] }>("/api/v1/library/items"),
  libraryItem: (itemId: string) =>
    request<{ item: LibraryItemSummary; entries: EpubEntrySummary[] }>(
      `/api/v1/library/items/${encodeURIComponent(itemId)}`,
    ),
  libraryRoots: () => request<{ items: LibraryRootSummary[] }>("/api/v1/library/roots"),
  addLibraryRoot: (nodeId: string) =>
    request<{ items: LibraryRootSummary[] }>("/api/v1/library/roots", {
      method: "POST",
      body: JSON.stringify({ nodeId }),
    }),
  removeLibraryRoot: (nodeId: string) =>
    request<undefined>(`/api/v1/library/roots/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
    }),
  libraryPageUrl: (itemId: string, page: number) =>
    `/api/v1/library/items/${encodeURIComponent(itemId)}/pages/${page}`,
  epubEntry: async (itemId: string, entryId: string) => {
    const response = await fetch(
      `/api/v1/library/items/${encodeURIComponent(itemId)}/entries/${encodeURIComponent(entryId)}`,
    );
    if (!response.ok) throw await responseError(response);
    return response.text();
  },
  saveReadingState: (itemId: string, position: ReadingPosition) =>
    request<undefined>(`/api/v1/library/items/${encodeURIComponent(itemId)}/reading-state`, {
      method: "PUT",
      body: JSON.stringify(position),
    }),
  recent: () => request<{ items: NodeSummary[] }>("/api/v1/recent"),
  starred: () => request<{ items: NodeSummary[] }>("/api/v1/starred"),
  setStar: (nodeId: string, starred: boolean) =>
    request<undefined>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/star`, {
      method: "PUT",
      body: JSON.stringify({ starred }),
    }),
  trashNode: (nodeId: string) =>
    request<{ trashOpId: string }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
    }),
  trash: () => request<TrashPage>("/api/v1/trash"),
  restoreTrash: (opId: string) =>
    request<NodeSummary>(`/api/v1/trash/${encodeURIComponent(opId)}/restore`, {
      method: "POST",
      body: "{}",
    }),
  purgeTrash: (opId: string) =>
    request<{ purged: boolean; members: number }>(
      `/api/v1/trash/${encodeURIComponent(opId)}/purge`,
      { method: "POST", body: "{}" },
    ),
  shares: () => request<{ items: ShareSummary[] }>("/api/v1/shares"),
  createShare: (input: {
    rootNodeId: string;
    kind: ShareKind;
    mode: ShareMode;
    expiresAt?: number | null;
    password?: string;
    granteeEmail?: string;
  }) =>
    request<ShareSummary>("/api/v1/shares", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateShare: (
    shareId: string,
    input: { mode?: ShareMode; expiresAt?: number | null; password?: string | null },
  ) =>
    request<ShareSummary>(`/api/v1/shares/${encodeURIComponent(shareId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  disableShare: (shareId: string) =>
    request<undefined>(`/api/v1/shares/${encodeURIComponent(shareId)}`, {
      method: "DELETE",
    }),
  sharedWithMe: () => request<{ items: SharedMount[] }>("/api/v1/shared-with-me"),
  appPasswords: () => request<{ items: AppPasswordSummary[] }>("/api/v1/app-passwords"),
  createAppPassword: (label: string, expiresInDays: number) =>
    request<CreatedAppPassword>("/api/v1/app-passwords", {
      method: "POST",
      body: JSON.stringify({ label, expiresInDays }),
    }),
  revokeAppPassword: (credentialId: string) =>
    request<undefined>(`/api/v1/app-passwords/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
    }),
  createZip: (nodeId: string) =>
    request<{ id: string; size: number; expiresAt: number }>(
      `/api/v1/nodes/${encodeURIComponent(nodeId)}/zip`,
      { method: "POST", body: "{}" },
    ),
};
