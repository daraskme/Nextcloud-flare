const app = document.querySelector("#app");
const shareId = /^\/s\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1];
const state = { share: null, stack: [], pages: new Map() };

class RequestError extends Error {
  constructor(status) {
    super(String(status));
    this.status = status;
  }
}

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  return node;
}

function showError(title, message) {
  const card = element("section", { className: "status-card error" });
  const mark = element("span", { className: "mark", text: "N" });
  const heading = element("h1", { text: title });
  const detail = element("p", { text: message });
  card.append(mark, heading, detail);
  app.replaceChildren(card);
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new RequestError(response.status);
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function csrf() {
  return request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/csrf`, {
    method: "POST",
  });
}

async function unlock(secret, password) {
  if (!secret) return;
  await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, ...(password === undefined ? {} : { password }) }),
  });
  history.replaceState(null, "", location.pathname);
}

async function openShare() {
  state.share = await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}`);
  renderShare();
}

function renderPassword(secret) {
  const card = element("section", { className: "status-card password-card" });
  const mark = element("span", { className: "mark", text: "N" });
  const heading = element("h1", { text: "パスワードが必要です" });
  const detail = element("p", {
    text: "共有者から受け取ったパスワードを入力してください。",
  });
  const form = element("form", { className: "password-form" });
  const label = element("label", { text: "パスワード" });
  const input = element("input");
  input.type = "password";
  input.name = "password";
  input.autocomplete = "current-password";
  input.required = true;
  const error = element("p", { className: "password-error" });
  error.setAttribute("role", "alert");
  const submit = element("button", { className: "primary-button", text: "共有を開く" });
  submit.type = "submit";
  label.append(input);
  form.append(label, error, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      await unlock(secret, input.value);
      input.value = "";
      await openShare();
    } catch (failure) {
      if (failure instanceof RequestError && failure.status === 401)
        error.textContent = "パスワードが正しくありません。";
      else if (failure instanceof RequestError && failure.status === 429)
        error.textContent = "試行回数が上限に達しました。しばらく待ってから再試行してください。";
      else error.textContent = "現在確認できません。しばらく待ってから再試行してください。";
      submit.disabled = false;
      input.select();
    }
  });
  card.append(mark, heading, detail, form);
  app.replaceChildren(card);
  input.focus();
}

function date(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function size(value) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

async function downloadFile(node, button) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  let csrf;
  let issued;
  try {
    csrf = await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/csrf`, {
      method: "POST",
    });
    issued = await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        targets: [{ spaceId: state.share.root.spaceId, nodeId: node.id }],
        purpose: "content",
        ttlSeconds: 300,
      }),
    });
    const accepted = await fetch(`${state.share.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: issued.ticket }),
    });
    if (!accepted.ok) throw new Error(String(accepted.status));
    location.assign(
      `${state.share.contentOrigin}/c/${encodeURIComponent(node.id)}/${encodeURIComponent(node.currentBlobId)}`,
    );
    button.disabled = false;
    button.removeAttribute("aria-busy");
  } catch {
    if (csrf && issued) {
      void request(
        `/api/v1/public/shares/${encodeURIComponent(shareId)}/tickets/${encodeURIComponent(issued.ticketId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        },
      ).catch(() => {});
    }
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function page(folderId, cursor) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(
    `/api/v1/public/shares/${encodeURIComponent(shareId)}/children/${encodeURIComponent(folderId)}${query}`,
  );
}

function renderPath(container) {
  const path = element("nav", { className: "path" });
  path.setAttribute("aria-label", "共有フォルダー");
  state.stack.forEach((folder, index) => {
    if (index) path.append(element("span", { text: "›" }));
    const button = element("button", { className: "path-button", text: folder.name });
    button.type = "button";
    button.addEventListener("click", () => {
      state.stack = state.stack.slice(0, index + 1);
      void renderFolder(container, folder.id);
    });
    path.append(button);
  });
  container.replaceWith(path);
  return path;
}

function renderRows(listing, folderId) {
  const current = state.pages.get(folderId);
  listing.replaceChildren();
  if (!current?.children.length) {
    const empty = element("div", { className: "empty" });
    empty.append(
      element("h2", { text: "このフォルダーは空です" }),
      element("p", { text: "共有されている項目はありません。" }),
    );
    listing.append(empty);
    return;
  }
  for (const node of current.children) {
    const row = element("article", { className: "node-row" });
    const button = element("button", { className: "node-button" });
    button.type = "button";
    const icon = element("span", {
      className: "node-icon",
      text: node.kind === "folder" ? "▰" : "▤",
    });
    const name = element("strong", { className: "node-name", text: node.name });
    button.append(icon, name);
    if (node.kind === "folder") {
      button.addEventListener("click", () => {
        state.stack.push({ id: node.id, name: node.name });
        void renderFolder(document.querySelector(".path"), node.id);
      });
    } else if (node.currentBlobId) {
      button.addEventListener("click", () => void downloadFile(node, button));
    } else {
      button.disabled = true;
    }
    row.append(
      button,
      element("span", { className: "node-meta", text: date(node.updatedAt) }),
      element("span", {
        className: "node-meta",
        text: node.kind === "folder" ? "フォルダー" : size(node.size),
      }),
    );
    listing.append(row);
  }
  if (current.nextCursor) {
    const more = element("button", { className: "more", text: "さらに読み込む" });
    more.type = "button";
    more.addEventListener("click", async () => {
      more.disabled = true;
      try {
        const next = await page(folderId, current.nextCursor);
        current.children.push(...next.children);
        current.nextCursor = next.nextCursor;
        renderRows(listing, folderId);
      } catch {
        more.disabled = false;
      }
    });
    listing.append(more);
  }
}

async function renderFolder(pathNode, folderId) {
  const shell = document.querySelector(".share-shell");
  const listing = shell.querySelector(".listing");
  renderPath(pathNode);
  listing.replaceChildren(element("div", { className: "empty", text: "読み込み中…" }));
  try {
    if (!state.pages.has(folderId)) state.pages.set(folderId, await page(folderId));
    renderRows(listing, folderId);
  } catch {
    showError("フォルダーを開けません", "共有状態が変更された可能性があります。");
  }
}

async function abortUpload(uploadId, capability, token) {
  await request(
    `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(uploadId)}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "Upload-Capability": capability,
        "X-CSRF-Token": token,
      },
      body: "{}",
    },
  );
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class UploadPendingError extends Error {}

function uploadEntry(file) {
  return {
    file,
    mode: file.size === 0 || file.size <= 95_000_000 ? "single" : "multipart",
    createKey: crypto.randomUUID(),
    completeKey: crypto.randomUUID(),
    uploadId: null,
    capability: null,
    ready: false,
    singleWritten: false,
    partBytes: null,
    partCount: null,
    partAttempts: new Map(),
    completedParts: new Set(),
  };
}

function resetUploadEntry(entry) {
  Object.assign(entry, uploadEntry(entry.file));
}

async function ensureUploadReceipt(entry, token) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const created = await fetch(`/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": entry.createKey,
        "X-CSRF-Token": token,
      },
      body: JSON.stringify({
        mode: entry.mode,
        name: entry.file.name,
        declared_size: entry.file.size,
      }),
    });
    if (!created.ok) throw new RequestError(created.status);
    const createdBody = await created.json();
    const uploadId = createdBody.receiptId;
    const capability = created.headers.get("Upload-Capability");
    if (!uploadId || !capability) throw new Error("invalid_upload_receipt");
    if (entry.uploadId && (entry.uploadId !== uploadId || entry.capability !== capability))
      throw new Error("invalid_upload_receipt");
    entry.uploadId = uploadId;
    entry.capability = capability;
    if (entry.mode === "multipart") {
      entry.partBytes = Number(created.headers.get("Upload-Part-Bytes"));
      entry.partCount = Number(created.headers.get("Upload-Part-Count"));
      if (
        !Number.isSafeInteger(entry.partBytes) ||
        entry.partBytes < 1 ||
        !Number.isSafeInteger(entry.partCount) ||
        entry.partCount < 1
      )
        throw new Error("invalid_upload_plan");
    }
    if (created.status !== 202) {
      entry.ready = true;
      return;
    }
    await pause(1_000);
  }
  throw new UploadPendingError();
}

async function reconcileUpload(entry) {
  if (!entry.uploadId || !entry.capability || !entry.ready) return false;
  const response = await fetch(
    `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(entry.uploadId)}`,
    {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Upload-Capability": entry.capability },
    },
  );
  if (!response.ok) throw new RequestError(response.status);
  const status = await response.json();
  if (status.state === "completed") return true;
  if (entry.mode === "single" && status.state === "completing") entry.singleWritten = true;
  if (entry.mode === "multipart") {
    for (const part of status.parts ?? []) {
      if (part.state === "completed") entry.completedParts.add(part.partNumber);
    }
    if (status.state === "completing") {
      for (let part = 1; part <= entry.partCount; part += 1) entry.completedParts.add(part);
    }
  }
  return false;
}

async function writeMultipartEntry(entry, part, report) {
  if (entry.completedParts.has(part)) return;
  const start = (part - 1) * entry.partBytes;
  const chunk = entry.file.slice(start, Math.min(entry.file.size, start + entry.partBytes));
  const attemptId = entry.partAttempts.get(part) ?? crypto.randomUUID();
  entry.partAttempts.set(part, attemptId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const written = await fetch(
      `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(entry.uploadId)}/parts/${part}`,
      {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Upload-Attempt-Id": attemptId,
          "Upload-Capability": entry.capability,
        },
        body: chunk,
      },
    );
    if (!written.ok) throw new RequestError(written.status);
    const result = await written.json();
    if (result.disposition === "completed") {
      entry.completedParts.add(part);
      report(Math.min(entry.file.size, start + chunk.size), entry.file.size);
      return;
    }
    if (result.disposition !== "in_flight") throw new Error("invalid_upload_part");
    await pause(1_000);
  }
  throw new UploadPendingError();
}

async function uploadFile(entry, token, report) {
  if (!entry.ready) await ensureUploadReceipt(entry, token);
  if (await reconcileUpload(entry)) return;
  let publicationStarted = false;
  try {
    if (entry.mode === "single" && !entry.singleWritten) {
      const written = await fetch(
        `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(entry.uploadId)}/content`,
        {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "Upload-Capability": entry.capability },
          body: entry.file,
        },
      );
      if (!written.ok) throw new RequestError(written.status);
      entry.singleWritten = true;
      report(entry.file.size, entry.file.size);
    } else if (entry.mode === "multipart") {
      for (let part = 1; part <= entry.partCount; part += 1)
        await writeMultipartEntry(entry, part, report);
    }
    publicationStarted = true;
    let completed;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      completed = await fetch(
        `/api/v1/public/shares/${encodeURIComponent(shareId)}/uploads/${encodeURIComponent(entry.uploadId)}/complete`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": entry.completeKey,
            "Upload-Capability": entry.capability,
            "X-CSRF-Token": token,
          },
          body: "{}",
        },
      );
      if (completed.status !== 503) break;
      await pause(1_000);
    }
    if (completed?.status === 503) throw new UploadPendingError();
    if (!completed?.ok) throw new RequestError(completed?.status ?? 503);
  } catch (error) {
    const abortable =
      error instanceof RequestError && [400, 409, 413, 423, 507].includes(error.status);
    if (!publicationStarted && abortable && entry.uploadId && entry.capability) {
      await abortUpload(entry.uploadId, entry.capability, token);
      resetUploadEntry(entry);
    }
    throw error;
  }
}

function uploadError(error) {
  if (error instanceof UploadPendingError)
    return "送信状態を確認中です。少し待ってから同じボタンで再開してください。";
  if (!(error instanceof RequestError))
    return "送信を完了できませんでした。通信状態を確認して再試行してください。";
  if (error.status === 413 || error.status === 507)
    return "ファイルサイズまたは受け取り容量の上限を超えています。";
  if (error.status === 429) return "送信が混み合っています。少し待ってから再試行してください。";
  if (error.status === 401 || error.status === 403)
    return "共有セッションの有効期限が切れました。リンクを開き直してください。";
  if (error.status === 409)
    return "送信状態を確認できませんでした。同じファイルを再送する前に共有者へ確認してください。";
  return "現在送信できません。しばらく待ってから再試行してください。";
}

function renderUploadShare(shell) {
  let queue = [];
  const panel = element("div", { className: "upload-panel" });
  const intro = element("div", { className: "upload-intro" });
  intro.append(
    element("h2", { text: "ファイルを送信" }),
    element("p", {
      text: "受け取り側では保存先の内容を閲覧できません。送信後のファイル名も表示されません。",
    }),
  );
  const input = element("input");
  input.type = "file";
  input.multiple = true;
  input.id = "upload-files";
  input.className = "upload-input";
  const choose = element("label", { className: "upload-drop", text: "ファイルを選択" });
  choose.htmlFor = input.id;
  const status = element("p", { className: "upload-status" });
  status.setAttribute("role", "status");
  const progress = element("progress", { className: "upload-progress" });
  progress.max = 1;
  progress.value = 0;
  const send = element("button", { className: "primary-button", text: "送信する" });
  send.type = "button";
  send.disabled = true;
  input.addEventListener("change", () => {
    queue.push(...[...(input.files ?? [])].map(uploadEntry));
    input.value = "";
    send.disabled = queue.length === 0;
    status.textContent = queue.length ? `${queue.length}件のファイルを選択しました。` : "";
    progress.value = 0;
  });
  send.addEventListener("click", async () => {
    if (!queue.length) return;
    input.disabled = true;
    send.disabled = true;
    const total = queue.length;
    let completed = 0;
    progress.max = total;
    progress.value = 0;
    try {
      const token = (await csrf()).token;
      while (queue.length) {
        const entry = queue[0];
        status.textContent = `${completed + 1}/${total}件目を送信しています…`;
        await uploadFile(entry, token, (done, bytes) => {
          progress.value = completed + (bytes ? done / bytes : 1);
        });
        queue.shift();
        completed += 1;
        progress.value = completed;
      }
      status.textContent = `${total}件を受け付けました。`;
    } catch (error) {
      status.textContent = uploadError(error);
    } finally {
      input.disabled = false;
      send.disabled = queue.length === 0;
    }
  });
  panel.append(intro, input, choose, progress, status, send);
  shell.append(panel);
}

function renderShare() {
  const shell = element("section", { className: "share-shell" });
  const header = element("header", { className: "share-header" });
  const brand = element("div", { className: "brand" });
  const mark = element("span", { className: "mark", text: "N" });
  const copy = element("div");
  const uploadOnly = state.share.kind === "upload_only";
  copy.append(
    element("h1", { text: uploadOnly ? "ファイル受け取り" : state.share.root.name }),
    element("p", {
      text: state.share.expiresAt
        ? `${date(state.share.expiresAt)} まで有効`
        : uploadOnly
          ? "アップロード専用共有"
          : "共有ファイル",
    }),
  );
  brand.append(mark, copy);
  const close = element("button", { className: "outline-button", text: "セッションを終了" });
  close.type = "button";
  close.addEventListener("click", async () => {
    try {
      const csrf = await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/csrf`, {
        method: "POST",
      });
      await request(`/api/v1/public/shares/${encodeURIComponent(shareId)}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        body: "{}",
      });
    } finally {
      showError("セッションを終了しました", "この共有リンクを閉じてください。");
    }
  });
  header.append(brand, close);
  const path = element("nav", { className: "path" });
  const listing = element("div", { className: "listing" });
  shell.append(header);
  app.replaceChildren(shell);
  if (uploadOnly) {
    renderUploadShare(shell);
    return;
  }
  shell.append(path, listing);
  state.stack = [{ id: state.share.root.id, name: state.share.root.name }];
  if (state.share.root.kind === "file") {
    state.pages.set(state.share.root.id, {
      children: [state.share.root],
      nextCursor: null,
    });
    renderPath(path);
    renderRows(listing, state.share.root.id);
  } else {
    void renderFolder(path, state.share.root.id);
  }
}

async function start() {
  if (!shareId) {
    showError("共有リンクが必要です", "受け取った共有リンクをそのまま開いてください。");
    return;
  }
  const secret = location.hash.slice(1);
  try {
    await unlock(secret);
    await openShare();
  } catch (error) {
    if (secret && error instanceof RequestError && error.status === 401) {
      history.replaceState(null, "", location.pathname);
      renderPassword(secret);
      return;
    }
    history.replaceState(null, "", location.pathname);
    showError("共有リンクを開けません", "リンクが無効、期限切れ、または共有が停止されています。");
  }
}

void start();
