const app = document.querySelector("#app");
const shareId = /^\/s\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname)?.[1];
const state = {
  share: null,
  stack: [],
  pages: new Map(),
  channels: new Map(),
  viewController: null,
};

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

function publicPath(path) {
  return `/api/v1/public/shares/${encodeURIComponent(shareId)}${path}`;
}

function extension(name) {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}

function playbackClock(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function mediaStatus(container, title, message, retry) {
  const status = element("div", { className: "media-status" });
  status.append(element("h2", { text: title }), element("p", { text: message }));
  if (retry) {
    const button = element("button", { className: "primary-button", text: "再試行" });
    button.type = "button";
    button.addEventListener("click", retry);
    status.append(button);
  }
  container.replaceChildren(status);
}

function publicFailure(error, fallback) {
  if (!(error instanceof RequestError))
    return "通信を確認できませんでした。しばらく待ってから再試行してください。";
  if (error.status === 401 || error.status === 403)
    return "共有が再ロックされたか、セッションの有効期限が切れました。リンクを開き直してください。";
  if (error.status === 404)
    return "共有が停止・期限切れになったか、対象が更新されました。一覧を読み直してください。";
  if (error.status === 409)
    return "対象の版が変わりました。古い再生・読書セッションは使用せず、一覧を読み直してください。";
  if (error.status === 429) return "配信が混み合っています。少し待ってから再試行してください。";
  return fallback;
}

async function cancelChannel(name) {
  const active = state.channels.get(name);
  if (!active) return;
  state.channels.delete(name);
  active.controller?.abort();
  if (!active.ticketId || !active.csrfToken) return;
  try {
    await request(publicPath(`/tickets/${encodeURIComponent(active.ticketId)}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": active.csrfToken },
    });
  } catch (error) {
    if (!(error instanceof RequestError) || ![401, 403, 404].includes(error.status)) throw error;
  }
}

async function cancelAllChannels() {
  const names = [...state.channels.keys()];
  await Promise.allSettled(names.map((name) => cancelChannel(name)));
}

async function prepareContentSession(targets, purpose, channel, externalSignal) {
  await cancelChannel(channel);
  const controller = new AbortController();
  const signals = [controller.signal, AbortSignal.timeout(30_000)];
  if (externalSignal) signals.push(externalSignal);
  const signal = AbortSignal.any(signals);
  const active = { controller, ticketId: null, csrfToken: null };
  state.channels.set(channel, active);
  let issued;
  try {
    const csrfBody = await csrf();
    signal.throwIfAborted();
    active.csrfToken = csrfBody.token;
    issued = await request(publicPath("/tickets"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfBody.token },
      body: JSON.stringify({
        targets: targets.map((target) => ({
          spaceId: state.share.root.spaceId,
          nodeId: target.id,
        })),
        purpose,
        ttlSeconds: 300,
      }),
      signal,
    });
    active.ticketId = issued.ticketId;
    signal.throwIfAborted();
    if (state.channels.get(channel) !== active) throw new DOMException("Stale", "AbortError");
    const accepted = await fetch(`${state.share.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: issued.ticket }),
      signal,
    });
    if (!accepted.ok) throw new RequestError(accepted.status);
    signal.throwIfAborted();
    return {
      ticketId: issued.ticketId,
      url(target, entryToken) {
        const base = `${state.share.contentOrigin}/c/${encodeURIComponent(target.id)}/${encodeURIComponent(target.currentBlobId)}`;
        if (purpose === "thumb") return `${base}/thumb`;
        if (purpose === "track") return `${base}/track`;
        if (purpose === "page") {
          if (!entryToken) throw new Error("missing_epub_entry");
          return `${base}/entries/${encodeURIComponent(entryToken)}`;
        }
        return base;
      },
      cancel: () => cancelChannel(channel),
    };
  } catch (error) {
    if (state.channels.get(channel) === active) {
      if (issued) {
        active.ticketId = issued.ticketId;
        await cancelChannel(channel).catch(() => {});
      } else {
        state.channels.delete(channel);
        controller.abort();
      }
    }
    throw error;
  }
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

async function downloadZip(button) {
  const current = state.stack.at(-1);
  if (!current) return;
  const status = document.querySelector(".zip-status");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (status) status.textContent = "ZIPを準備しています…";
  await cancelChannel("zip");
  const controller = new AbortController();
  const active = { controller, ticketId: null, csrfToken: null };
  state.channels.set("zip", active);
  try {
    const csrfBody = await csrf();
    active.csrfToken = csrfBody.token;
    const issued = await request(publicPath(`/nodes/${encodeURIComponent(current.id)}/zip`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfBody.token,
      },
      body: "{}",
      signal: controller.signal,
    });
    active.ticketId = issued.ticketId;
    controller.signal.throwIfAborted();
    const accepted = await fetch(`${state.share.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: issued.ticket }),
      signal: controller.signal,
    });
    if (!accepted.ok) throw new RequestError(accepted.status);
    const link = element("a");
    link.href = publicPath(`/zips/${encodeURIComponent(issued.targetSetId)}`);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    if (status)
      status.textContent =
        "ダウンロードを開始しました。再実行・画面移動・ログアウト時は古い配信枠を取り消します。";
  } catch (error) {
    await cancelChannel("zip").catch(() => {});
    if (status) {
      status.textContent = publicFailure(
        error,
        "ZIPを作成できませんでした。容量・項目数の上限を確認して再試行してください。",
      );
    }
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function modal(title) {
  const overlay = element("div", { className: "media-overlay" });
  const dialog = element("section", { className: "media-dialog" });
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title);
  const header = element("header", { className: "media-dialog-header" });
  const heading = element("h2", { text: title });
  const close = element("button", { className: "icon-button", text: "閉じる" });
  close.type = "button";
  header.append(heading, close);
  dialog.append(header);
  overlay.append(dialog);
  document.body.append(overlay);
  return { overlay, dialog, close };
}

async function openGalleryItem(item) {
  const { overlay, dialog, close } = modal(item.name);
  const body = element("div", { className: "media-dialog-body" });
  body.append(element("p", { className: "muted", text: "原本を確認しています…" }));
  dialog.append(body);
  const finish = async () => {
    await cancelChannel("gallery-original").catch(() => {});
    overlay.remove();
  };
  close.addEventListener("click", () => void finish());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) void finish();
  });
  try {
    const session = await prepareContentSession([item], "content", "gallery-original");
    if (!overlay.isConnected) {
      await session.cancel();
      return;
    }
    const image = element("img", { className: "gallery-original", alt: item.name });
    image.src = session.url(item);
    image.addEventListener("error", () => {
      void session.cancel().catch(() => {});
      mediaStatus(
        body,
        "画像を表示できません",
        "原本が更新・削除されたか、ブラウザーで扱えない形式です。ファイル一覧からダウンロードできます。",
      );
    });
    body.replaceChildren(image);
  } catch (error) {
    if (error.name === "AbortError") return;
    mediaStatus(
      body,
      "画像を表示できません",
      publicFailure(error, "原本の配信セッションを開始できませんでした。"),
    );
  }
}

async function renderGallery(container, signal) {
  mediaStatus(container, "ギャラリー", "画像を読み込んでいます…");
  try {
    const gallery = await request(publicPath("/gallery?recursive=1"), { signal });
    signal.throwIfAborted();
    if (!gallery.items.length) {
      mediaStatus(container, "ギャラリー", "この共有に表示できる画像はありません。");
      return;
    }
    const ready = gallery.items.filter((item) => item.currentBlobId && item.thumbnail === "ready");
    const grid = element("div", { className: "gallery-grid" });
    container.replaceChildren(grid);
    let session;
    if (ready.length)
      session = await prepareContentSession(ready, "thumb", "gallery-thumbnails", signal);
    signal.throwIfAborted();
    for (const item of gallery.items) {
      const button = element("button", { className: "gallery-card" });
      button.type = "button";
      const frame = element("span", { className: "gallery-frame" });
      if (session && item.thumbnail === "ready") {
        const image = element("img", { alt: "", className: "gallery-thumb" });
        image.src = session.url(item);
        image.addEventListener("error", () => {
          frame.replaceChildren(element("span", { className: "media-fallback", text: "表示失敗" }));
        });
        frame.append(image);
      } else {
        frame.append(
          element("span", {
            className: "media-fallback",
            text: item.thumbnail === "failed" ? "生成失敗" : "準備中",
          }),
        );
      }
      button.append(frame, element("strong", { text: item.name }));
      button.addEventListener("click", () => void openGalleryItem(item));
      grid.append(button);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    mediaStatus(
      container,
      "ギャラリーを開けません",
      publicFailure(error, "画像一覧を取得できませんでした。"),
      () => void switchView("gallery"),
    );
  }
}

async function playAudio(track, player, status, button) {
  button.disabled = true;
  status.textContent = "再生準備中…";
  player.pause();
  player.removeAttribute("src");
  player.load();
  try {
    const session = await prepareContentSession([track], "track", "audio-track");
    const url = session.url(track);
    const probe = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    if (!probe.ok) throw new RequestError(probe.status);
    const type = probe.headers.get("Content-Type") ?? track.mime ?? "";
    if (!type.toLowerCase().startsWith("audio/") || player.canPlayType(type) === "")
      throw new Error("unsupported_audio");
    player.src = url;
    status.textContent = `${track.title ?? track.name} · ${playbackClock(track.durationMs)}`;
  } catch (error) {
    await cancelChannel("audio-track").catch(() => {});
    status.textContent =
      error.message === "unsupported_audio"
        ? "この音声形式はブラウザーで再生できません。ファイル一覧からダウンロードしてください。"
        : publicFailure(error, "音声の再生セッションを開始できませんでした。");
  } finally {
    button.disabled = false;
  }
}

async function renderAudio(container, signal) {
  mediaStatus(container, "オーディオ", "トラックを読み込んでいます…");
  try {
    const tracks = await request(publicPath("/tracks?recursive=1"), { signal });
    signal.throwIfAborted();
    if (!tracks.items.length) {
      mediaStatus(container, "オーディオ", "この共有に再生できる音声はありません。");
      return;
    }
    const player = element("audio", { className: "audio-player" });
    player.controls = true;
    player.preload = "none";
    const status = element("p", {
      className: "media-note",
      text: "トラックを選択してください。",
    });
    player.addEventListener("error", () => {
      void cancelChannel("audio-track").catch(() => {});
      player.removeAttribute("src");
      status.textContent =
        "ネイティブ再生に失敗しました。形式が未対応か、共有状態が変わっています。";
    });
    const list = element("div", { className: "track-list" });
    for (const track of tracks.items) {
      const button = element("button", { className: "track-row" });
      button.type = "button";
      button.append(
        element("strong", { text: track.title ?? track.name }),
        element("span", {
          text: `${track.artist ?? "アーティスト不明"} · ${playbackClock(track.durationMs)}`,
        }),
      );
      button.addEventListener("click", () => void playAudio(track, player, status, button));
      list.append(button);
    }
    container.replaceChildren(element("h2", { text: "オーディオ" }), player, status, list);
  } catch (error) {
    if (error.name === "AbortError") return;
    mediaStatus(
      container,
      "オーディオを開けません",
      publicFailure(error, "トラック一覧を取得できませんでした。"),
      () => void switchView("audio"),
    );
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
    const actions = element("span", { className: "node-actions" });
    if (node.kind === "file" && extension(node.name) === "epub") {
      const read = element("button", { className: "text-button", text: "読む" });
      read.type = "button";
      read.disabled = !node.currentBlobId;
      read.addEventListener("click", () => void openReader(node));
      actions.append(read);
    }
    if (
      node.kind === "file" &&
      ["mp4", "m4v", "webm", "mov", "ogv"].includes(extension(node.name))
    ) {
      const play = element("button", { className: "text-button", text: "再生" });
      play.type = "button";
      play.disabled = !node.currentBlobId;
      play.addEventListener("click", () => void openVideo(node));
      actions.append(play);
    }
    row.append(
      button,
      element("span", { className: "node-meta", text: date(node.updatedAt) }),
      element("span", {
        className: "node-meta",
        text: node.kind === "folder" ? "フォルダー" : size(node.size),
      }),
      actions,
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

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chapterDocument(markup, title) {
  const parsed = new DOMParser().parseFromString(markup, "application/xhtml+xml");
  if (parsed.querySelector("parsererror")) throw new Error("malformed_epub");
  const text = parsed.body?.textContent?.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("malformed_epub");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{max-width:44rem;margin:0 auto;padding:2.5rem 2rem;font:1rem/1.9 ui-serif,serif;color:#20242a;background:#fff}p{white-space:pre-wrap}</style></head><body><p>${escapeHtml(text)}</p></body></html>`;
}

async function openReader(node) {
  const { overlay, dialog, close } = modal(node.name);
  const body = element("div", { className: "reader-body" });
  body.append(element("p", { className: "muted", text: "書籍情報を確認しています…" }));
  dialog.classList.add("reader-dialog");
  dialog.append(body);
  let chapter = 0;
  let publication;
  let closed = false;
  const finish = async () => {
    closed = true;
    await cancelChannel("epub-page").catch(() => {});
    overlay.remove();
  };
  close.addEventListener("click", () => void finish());

  const loadChapter = async (index) => {
    const controls = body.querySelector(".reader-controls");
    if (controls) for (const button of controls.querySelectorAll("button")) button.disabled = true;
    try {
      const entryToken = publication.spine[index];
      const session = await prepareContentSession([node], "page", "epub-page");
      const response = await fetch(session.url(node, entryToken), {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new RequestError(response.status);
      const markup = await response.text();
      if (closed) {
        await session.cancel();
        return;
      }
      const frame = element("iframe", {
        className: "reader-frame",
        title: `${publication.title ?? node.name} 第${index + 1}章`,
      });
      frame.setAttribute("sandbox", "");
      frame.srcdoc = chapterDocument(markup, publication.title ?? node.name);
      chapter = index;
      const previous = element("button", { className: "outline-button", text: "前の章" });
      previous.type = "button";
      previous.disabled = chapter === 0;
      previous.addEventListener("click", () => void loadChapter(chapter - 1));
      const next = element("button", { className: "outline-button", text: "次の章" });
      next.type = "button";
      next.disabled = chapter >= publication.spine.length - 1;
      next.addEventListener("click", () => void loadChapter(chapter + 1));
      const controlsNode = element("div", { className: "reader-controls" });
      controlsNode.append(
        previous,
        element("span", { text: `${chapter + 1} / ${publication.spine.length}` }),
        next,
      );
      body.replaceChildren(
        element("p", {
          className: "media-note",
          text: publication.author
            ? `${publication.title ?? node.name} · ${publication.author}`
            : (publication.title ?? node.name),
        }),
        frame,
        controlsNode,
      );
    } catch (error) {
      if (error.name === "AbortError") return;
      await cancelChannel("epub-page").catch(() => {});
      mediaStatus(
        body,
        "この書籍を表示できません",
        error.message === "malformed_epub"
          ? "EPUB本文が不正です。安全のため表示を中止しました。"
          : publicFailure(
              error,
              "未対応・暗号化・固定レイアウトのEPUBか、現在の投影が利用できません。",
            ),
        () => void loadChapter(chapter),
      );
    }
  };

  try {
    publication = await request(publicPath(`/library/${encodeURIComponent(node.id)}`));
    if (
      publication.nodeId !== node.id ||
      publication.blobId !== node.currentBlobId ||
      !Array.isArray(publication.spine) ||
      !publication.spine.length
    )
      throw new Error("malformed_epub");
    await loadChapter(0);
  } catch (error) {
    if (closed || error.name === "AbortError") return;
    mediaStatus(
      body,
      "この書籍を開けません",
      error.message === "malformed_epub"
        ? "EPUB情報が不正です。安全のため表示を中止しました。"
        : publicFailure(
            error,
            "未対応・暗号化・固定レイアウトのEPUBか、現在の投影が利用できません。",
          ),
      () => {
        overlay.remove();
        void openReader(node);
      },
    );
  }
}

async function openVideo(node) {
  const { overlay, dialog, close } = modal(node.name);
  const body = element("div", { className: "video-body" });
  body.append(element("p", { className: "muted", text: "動画を確認しています…" }));
  dialog.append(body);
  const finish = async () => {
    await cancelChannel("video-track").catch(() => {});
    overlay.remove();
  };
  close.addEventListener("click", () => void finish());
  try {
    const session = await prepareContentSession([node], "track", "video-track");
    const url = session.url(node);
    const probe = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    if (!probe.ok) throw new RequestError(probe.status);
    const contentType = probe.headers.get("Content-Type") ?? "";
    const video = element("video", { className: "video-player" });
    video.controls = true;
    video.preload = "none";
    if (!contentType.toLowerCase().startsWith("video/") || video.canPlayType(contentType) === "")
      throw new Error("unsupported_video");
    video.src = url;
    video.addEventListener("error", () => {
      void session.cancel().catch(() => {});
      mediaStatus(
        body,
        "動画を再生できません",
        "ネイティブ再生に失敗しました。ファイル一覧からダウンロードしてください。",
      );
    });
    body.replaceChildren(video);
  } catch (error) {
    await cancelChannel("video-track").catch(() => {});
    mediaStatus(
      body,
      "動画を再生できません",
      error.message === "unsupported_video"
        ? "このコンテナまたはコーデックはブラウザーで再生できません。ファイル一覧からダウンロードしてください。"
        : publicFailure(error, "動画の配信セッションを開始できませんでした。"),
    );
  }
}

function renderFiles(container) {
  const path = element("nav", { className: "path" });
  const listing = element("div", { className: "listing" });
  container.replaceChildren(path, listing);
  void renderFolder(path, state.stack.at(-1).id);
}

async function switchView(name) {
  state.viewController?.abort();
  const controller = new AbortController();
  state.viewController = controller;
  await cancelAllChannels();
  if (state.viewController !== controller || controller.signal.aborted) return;
  const container = document.querySelector(".share-view");
  if (!container) return;
  for (const button of document.querySelectorAll(".media-tab")) {
    const selected = button.dataset.view === name;
    button.setAttribute("aria-selected", String(selected));
    button.classList.toggle("active", selected);
  }
  if (name === "gallery") {
    await renderGallery(container, controller.signal);
    return;
  }
  if (name === "audio") {
    await renderAudio(container, controller.signal);
    return;
  }
  renderFiles(container);
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
  const actions = element("div", { className: "share-actions" });
  if (!uploadOnly) {
    const download = element("button", {
      className: "outline-button",
      text: "ZIPをダウンロード",
    });
    download.type = "button";
    download.addEventListener("click", () => void downloadZip(download));
    actions.append(download);
  }
  const close = element("button", { className: "outline-button", text: "セッションを終了" });
  close.type = "button";
  close.addEventListener("click", async () => {
    try {
      state.viewController?.abort();
      await cancelAllChannels();
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
  actions.append(close);
  header.append(brand, actions);
  shell.append(header);
  app.replaceChildren(shell);
  if (uploadOnly) {
    renderUploadShare(shell);
    return;
  }
  const zipStatus = element("p", { className: "zip-status" });
  zipStatus.setAttribute("role", "status");
  const tabs = element("nav", { className: "media-tabs" });
  tabs.setAttribute("aria-label", "共有コンテンツ");
  const views =
    state.share.root.kind === "file"
      ? [["files", "ファイル"]]
      : [
          ["files", "ファイル"],
          ["gallery", "ギャラリー"],
          ["audio", "オーディオ"],
        ];
  for (const [view, label] of views) {
    const tab = element("button", { className: "media-tab", text: label });
    tab.type = "button";
    tab.dataset.view = view;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => void switchView(view));
    tabs.append(tab);
  }
  const view = element("div", { className: "share-view" });
  shell.append(zipStatus, tabs, view);
  state.stack = [{ id: state.share.root.id, name: state.share.root.name }];
  if (state.share.root.kind === "file") {
    state.pages.set(state.share.root.id, {
      children: [state.share.root],
      nextCursor: null,
    });
  }
  void switchView("files");
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
