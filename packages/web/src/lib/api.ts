import type {
  BreadcrumbItem,
  ChildrenPage,
  NodeSummary,
  TrashPage,
  UploadInfo,
  UploadMode,
} from "@ncf/shared";

interface MeResponse {
  user: { id: string; email: string; role: "member" | "app_admin" };
  workspace: { rootId: string; spaceId: string; treeGeneration: number };
}

let csrfToken: string | null = null;

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `Request failed (${response.status})`;
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
    throw new Error(await errorMessage(response));
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
    throw new Error(await errorMessage(response));
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
  completeUpload: (uploadId: string, capability: string) =>
    request<NodeSummary>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      headers: { "Upload-Capability": capability },
    }),
  abortUpload: (uploadId: string, capability: string) =>
    request<undefined>(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: { "Upload-Capability": capability },
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
};
