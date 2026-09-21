import { t } from "./i18n";

interface PublicNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  size: number | null;
  updatedAt: number;
}

interface PublicShare {
  id: string;
  mode: "view" | "download" | "upload";
  expiresAt: number | null;
  root: PublicNode | null;
}

const mountElement = document.querySelector<HTMLElement>("#public-share");
if (mountElement === null) throw new Error("Public share root is missing");
const mount: HTMLElement = mountElement;

const parts = window.location.pathname.split("/").filter(Boolean);
const shareId = parts[0] === "s" ? parts[1] : undefined;
let secret = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
let csrfToken = "";
let share: PublicShare | null = null;
const trail: PublicNode[] = [];

if (window.location.hash !== "") history.replaceState(null, "", window.location.pathname);

function escapeText(value: string): Text {
  return document.createTextNode(value);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return t("files.folder");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `Request failed (${response.status})`;
}

async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, { ...init, credentials: "include" });
  return response;
}

async function csrf(): Promise<string> {
  if (csrfToken !== "") return csrfToken;
  const response = await publicFetch(
    `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/csrf`,
    {
      method: "POST",
    },
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = (await response.json()) as { token: string };
  csrfToken = body.token;
  return csrfToken;
}

async function mutation(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-CSRF-Token", await csrf());
  const response = await publicFetch(path, { ...init, headers });
  if (response.status === 403) csrfToken = "";
  return response;
}

function shell(content: HTMLElement): void {
  mount.replaceChildren();
  const background = element("div", "ambient");
  const header = element("header", "public-header");
  const brand = element("a", "brand");
  brand.href = "/s";
  const mark = element("span", "brand-mark");
  mark.append(escapeText("N"));
  const brandText = element("span");
  brandText.append(escapeText("Next Cloud"));
  brand.append(mark, brandText);
  const badge = element("span", "privacy-badge");
  badge.append(escapeText(t("public.privateShare")));
  header.append(brand, badge);
  const frame = element("div", "public-frame");
  frame.append(content);
  mount.append(background, header, frame);
}

function message(title: string, detail: string): void {
  const card = element("section", "message-card");
  const icon = element("div", "message-icon");
  icon.append(escapeText("N"));
  const heading = element("h1");
  heading.append(escapeText(title));
  const text = element("p");
  text.append(escapeText(detail));
  card.append(icon, heading, text);
  shell(card);
}

function unlockForm(error?: string): void {
  const card = element("section", "unlock-card");
  const eyebrow = element("p", "eyebrow");
  eyebrow.append(escapeText(t("public.secureLink")));
  const heading = element("h1");
  heading.append(escapeText(t("public.sharedTitle")));
  const description = element("p", "lede");
  description.append(
    escapeText(secret === "" ? t("public.originalLink") : t("public.enterPassword")),
  );
  const form = element("form", "unlock-form");
  const password = element("input");
  password.type = "password";
  password.placeholder = t("public.password");
  password.autocomplete = "current-password";
  password.disabled = secret === "";
  const button = element("button", "action-button");
  button.type = "submit";
  button.disabled = secret === "";
  button.append(escapeText(t("public.open")));
  form.append(password, button);
  if (error !== undefined) {
    const alert = element("p", "alert");
    alert.append(escapeText(error));
    form.append(alert);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = t("public.opening");
    void unlock(password.value).catch((cause: unknown) => {
      unlockForm(cause instanceof Error ? cause.message : t("public.unlockError"));
    });
  });
  card.append(eyebrow, heading, description, form);
  shell(card);
}

async function unlock(password = ""): Promise<void> {
  if (shareId === undefined || secret === "") throw new Error(t("public.incomplete"));
  const response = await publicFetch(
    `/api/v1/public/shares/${encodeURIComponent(shareId)}/unlock`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, ...(password === "" ? {} : { password }) }),
    },
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  secret = "";
  await loadShare();
}

function renderToolbar(current: PublicNode): HTMLElement {
  const toolbar = element("div", "share-toolbar");
  const titleBlock = element("div");
  const eyebrow = element("p", "eyebrow");
  eyebrow.append(
    escapeText(share?.mode === "download" ? t("public.downloadShare") : t("public.viewShare")),
  );
  const heading = element("h1");
  heading.append(escapeText(current.name || t("public.sharedFiles")));
  titleBlock.append(eyebrow, heading);
  toolbar.append(titleBlock);
  if (share?.mode === "download") {
    const download = element("button", "action-button compact");
    download.append(
      escapeText(current.kind === "file" ? t("public.downloadFile") : t("public.downloadZip")),
    );
    download.addEventListener("click", () => {
      if (current.kind === "file") {
        window.location.assign(
          `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/content/${encodeURIComponent(current.id)}?download=1`,
        );
      } else {
        void downloadZip(current.id, download);
      }
    });
    toolbar.append(download);
  }
  return toolbar;
}

async function downloadZip(nodeId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = t("public.preparing");
  try {
    const response = await mutation(
      `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/nodes/${encodeURIComponent(nodeId)}/zip`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    const archive = (await response.json()) as { id: string };
    window.location.assign(
      `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/zips/${encodeURIComponent(archive.id)}`,
    );
    button.disabled = false;
    button.textContent = t("public.downloadZip");
  } catch (cause) {
    button.disabled = false;
    button.textContent = cause instanceof Error ? cause.message : t("public.downloadFailed");
  }
}

function renderBreadcrumbs(): HTMLElement {
  const navigation = element("nav", "breadcrumbs");
  trail.forEach((node, index) => {
    if (index > 0) {
      const separator = element("span");
      separator.append(escapeText("/"));
      navigation.append(separator);
    }
    const button = element("button");
    button.append(escapeText(node.name || t("public.sharedFiles")));
    button.addEventListener("click", () => {
      trail.splice(index + 1);
      void browse(node);
    });
    navigation.append(button);
  });
  return navigation;
}

function renderFiles(current: PublicNode, items: PublicNode[]): void {
  const content = element("section", "browser-card");
  content.append(renderToolbar(current), renderBreadcrumbs());
  const grid = element("div", "file-grid");
  if (items.length === 0) {
    const empty = element("div", "empty-state");
    empty.append(escapeText(t("public.empty")));
    grid.append(empty);
  }
  for (const item of items) {
    const card = element("button", "file-card");
    const icon = element("span", `file-icon ${item.kind === "file" ? "document" : "folder"}`);
    icon.append(escapeText(item.kind === "file" ? "F" : "D"));
    const name = element("strong");
    name.append(escapeText(item.name));
    const metadata = element("small");
    metadata.append(escapeText(formatSize(item.size)));
    card.append(icon, name, metadata);
    card.addEventListener("click", () => {
      if (item.kind === "folder") {
        trail.push(item);
        void browse(item);
      } else if (share?.mode === "download") {
        window.location.assign(
          `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/content/${encodeURIComponent(item.id)}?download=1`,
        );
      }
    });
    if (item.kind === "file" && share?.mode !== "download") card.classList.add("disabled-file");
    grid.append(card);
  }
  content.append(grid);
  shell(content);
}

async function browse(current: PublicNode): Promise<void> {
  const response = await publicFetch(
    `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}/children/${encodeURIComponent(current.id)}`,
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = (await response.json()) as { items: PublicNode[] };
  renderFiles(current, body.items);
}

function renderUpload(): void {
  const card = element("section", "upload-card");
  const eyebrow = element("p", "eyebrow");
  eyebrow.append(escapeText(t("public.uploadOnly")));
  const heading = element("h1");
  heading.append(escapeText(t("public.sendFiles")));
  const description = element("p", "lede");
  description.append(escapeText(t("public.uploadDescription")));
  const drop = element("label", "drop-zone");
  const input = element("input");
  input.type = "file";
  input.multiple = true;
  const label = element("strong");
  label.append(escapeText(t("public.chooseFiles")));
  const note = element("span");
  note.append(escapeText(t("public.maxSize")));
  drop.append(input, label, note);
  const queue = element("div", "upload-queue");
  const uploadFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) void uploadFile(file, queue);
  };
  input.addEventListener("change", () => input.files !== null && uploadFiles(input.files));
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    if (event.dataTransfer?.files !== undefined) uploadFiles(event.dataTransfer.files);
  });
  card.append(eyebrow, heading, description, drop, queue);
  shell(card);
}

async function uploadFile(file: File, queue: HTMLElement): Promise<void> {
  const row = element("div", "upload-row");
  const name = element("strong");
  name.append(escapeText(file.name));
  const status = element("span");
  status.append(escapeText(t("public.preparingFile")));
  row.append(name, status);
  queue.prepend(row);
  try {
    const base = `/api/v1/public/shares/${encodeURIComponent(shareId ?? "")}`;
    const create = await mutation(`${base}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentId: share?.root?.id ?? "upload-root",
        name: file.name,
        declaredSize: file.size,
        mode: "single",
      }),
    });
    if (!create.ok) throw new Error(await errorMessage(create));
    const receipt = (await create.json()) as { receipt_id: string };
    status.textContent = t("public.uploading");
    const put = await mutation(
      `${base}/uploads/${encodeURIComponent(receipt.receipt_id)}/content`,
      {
        method: "PUT",
        body: file,
      },
    );
    if (!put.ok) throw new Error(await errorMessage(put));
    status.textContent = t("public.saving");
    const complete = await mutation(
      `${base}/uploads/${encodeURIComponent(receipt.receipt_id)}/complete`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    if (!complete.ok) throw new Error(await errorMessage(complete));
    row.classList.add("complete");
    status.textContent = t("public.delivered");
  } catch (cause) {
    row.classList.add("failed");
    status.textContent = cause instanceof Error ? cause.message : t("public.uploadFailed");
  }
}

async function loadShare(): Promise<void> {
  if (shareId === undefined) {
    message(t("public.notFound"), t("public.notFoundBody"));
    return;
  }
  const response = await publicFetch(`/api/v1/public/shares/${encodeURIComponent(shareId)}`);
  if (!response.ok) {
    unlockForm();
    return;
  }
  share = (await response.json()) as PublicShare;
  if (share.mode === "upload") {
    renderUpload();
    return;
  }
  if (share.root === null) throw new Error("Share root is unavailable");
  trail.splice(0, trail.length, share.root);
  if (share.root.kind === "file") {
    renderFiles(share.root, []);
  } else {
    await browse(share.root);
  }
}

void (async () => {
  try {
    if (shareId === undefined) {
      message(t("public.notFound"), t("public.notFoundBody"));
      return;
    }
    const existing = await publicFetch(`/api/v1/public/shares/${encodeURIComponent(shareId)}`);
    if (existing.ok) {
      share = (await existing.json()) as PublicShare;
      if (share.mode === "upload") renderUpload();
      else if (share.root !== null) {
        trail.push(share.root);
        if (share.root.kind === "file") renderFiles(share.root, []);
        else await browse(share.root);
      }
    } else if (secret !== "") {
      await unlock();
    } else {
      unlockForm();
    }
  } catch (cause) {
    unlockForm(cause instanceof Error ? cause.message : t("public.loadError"));
  }
})();
