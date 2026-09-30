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
  return response.status === 204 ? null : response.json();
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

function renderShare() {
  const shell = element("section", { className: "share-shell" });
  const header = element("header", { className: "share-header" });
  const brand = element("div", { className: "brand" });
  const mark = element("span", { className: "mark", text: "N" });
  const copy = element("div");
  copy.append(
    element("h1", { text: state.share.root.name }),
    element("p", {
      text: state.share.expiresAt ? `${date(state.share.expiresAt)} まで有効` : "共有ファイル",
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
  shell.append(header, path, listing);
  app.replaceChildren(shell);
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
