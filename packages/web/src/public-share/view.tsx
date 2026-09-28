import { useCallback, useEffect, useRef, useState } from "react";
import { zipFailureMessage } from "../../../shared/src/zips";
import {
  PublicClient,
  PublicError,
  type PublicRoot,
  type SharedChildren,
  type SharedNode,
} from "./client";
import { PublicEditor } from "./editor";
import { forgetPublicEdits } from "./editStore";
import { forgetPublicUploads } from "./uploadStore";
import { PublicUploads } from "./uploads";

function size(bytes: number | null) {
  if (bytes === null) return "サイズ不明";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
export function PublicApp({ client }: { client: PublicClient }) {
  const [root, setRoot] = useState<PublicRoot | null>(null);
  const [trail, setTrail] = useState<SharedNode[]>([]);
  const [page, setPage] = useState<SharedChildren | null>(null);
  const [busy, setBusy] = useState(true),
    [message, setMessage] = useState("");
  const [password, setPassword] = useState(""),
    [retry, setRetry] = useState(0);
  const [closed, setClosed] = useState(false);
  const [editing, setEditing] = useState<{ node?: SharedNode; remove?: boolean } | null>(null);
  const [uploading, setUploading] = useState<{ node?: SharedNode } | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [editState, setEditState] = useState({ blocked: true, running: false });
  const locked =
    busy || editing !== null || uploading !== null || transferBusy || editState.running;
  const editLocked = locked || editState.blocked;
  const channel = useRef<BroadcastChannel | null>(null);
  const clear = useCallback(() => {
    client.close();
    void forgetPublicUploads(client.id, root?.sessionId).catch(() => {});
    void forgetPublicEdits(client.id, root?.sessionId).catch(() => {});
    setRoot(null);
    setTrail([]);
    setPage(null);
    setEditing(null);
    setUploading(null);
    setTransferBusy(false);
    setPassword("");
    setClosed(true);
    setBusy(false);
    setMessage("共有を閉じました。もう一度開くには、共有リンクからアクセスしてください。");
  }, [client, root?.sessionId]);
  const failed = useCallback(
    (error: unknown) => {
      if (client.lifetime.signal.aborted) return;
      if (error instanceof PublicError && error.status === 429) {
        setRetry(error.retryAfter);
        setMessage("しばらく待ってから、もう一度お試しください。");
      } else if (error instanceof PublicError && error.status === 410) {
        setMessage(
          "共有リンクを最初から開いてください。リンクの末尾までコピーされているか確認してください。",
        );
      } else if (error instanceof PublicError && [401, 403, 404].includes(error.status)) {
        setMessage(
          "共有を開けませんでした。パスワードが必要な場合は入力してください。リンクの期限や共有設定もご確認ください。",
        );
      } else {
        setMessage("接続を確認できませんでした。しばらくしてから再試行してください。");
      }
    },
    [client],
  );
  const open = useCallback(
    async (value: string, notice = "") => {
      setBusy(true);
      setMessage("");
      setPage(null);
      setRoot(null);
      setTrail([]);
      try {
        const loaded = await client.unlock(value);
        const items =
          loaded.kind === "upload_only" || loaded.root.kind === "file"
            ? null
            : await client.children(loaded.root.id);
        client.lifetime.signal.throwIfAborted();
        setRoot(loaded);
        setTrail(loaded.kind === "upload_only" ? [] : [loaded.root]);
        setPage(items);
        setPassword("");
        setMessage(notice);
      } catch (error) {
        failed(error);
      } finally {
        if (!client.lifetime.signal.aborted) setBusy(false);
      }
    },
    [client, failed],
  );
  useEffect(() => {
    void open("");
  }, [open]);
  useEffect(() => {
    if (!retry) return;
    const timer = setTimeout(() => setRetry(retry - 1), 1000);
    return () => clearTimeout(timer);
  }, [retry]);
  useEffect(() => {
    const c = new BroadcastChannel(`ncf-public:${client.id}`);
    channel.current = c;
    c.onmessage = (event) => {
      if (event.data === "logout") clear();
    };
    return () => {
      channel.current = null;
      c.close();
    };
  }, [client, clear]);
  useEffect(() => {
    if (!root) return;
    const timer = setTimeout(clear, Math.max(0, root.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [root, clear]);
  async function browse(next: SharedNode[], cursor?: string | null, notice = "") {
    const previous = page;
    setBusy(true);
    setMessage("");
    setPage(null);
    try {
      const result = await client.children(next.at(-1)!.id, cursor);
      setTrail(next);
      setPage({
        ...result,
        children: cursor ? [...(previous?.children ?? []), ...result.children] : result.children,
      });
      setMessage(notice);
    } catch (error) {
      setRoot(null);
      setTrail([]);
      failed(error);
    } finally {
      if (!client.lifetime.signal.aborted) setBusy(false);
    }
  }
  async function download(node: SharedNode) {
    if (!root || root.kind === "upload_only") return;
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setMessage("ファイルを開くため、ポップアップを許可してください。");
      return;
    }
    target.opener = null;
    setBusy(true);
    setMessage("");
    try {
      if (node.kind === "file") await client.download(root, node, target);
      else await client.downloadZip(root, node.id, target);
    } catch (error) {
      if (client.lifetime.signal.aborted) return;
      const zipMessage =
        node.kind !== "file" && error instanceof PublicError
          ? zipFailureMessage(error.status)
          : undefined;
      if (error instanceof PublicError && [401, 403, 404].includes(error.status)) {
        setRoot(null);
        setTrail([]);
        setPage(null);
      }
      if (zipMessage) setMessage(zipMessage);
      else failed(error);
    } finally {
      if (!client.lifetime.signal.aborted) setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setMessage("");
    try {
      await client.mutate("/logout", {});
      channel.current?.postMessage("logout");
      clear();
    } catch (error) {
      if (error instanceof PublicError && error.status === 401) {
        channel.current?.postMessage("logout");
        clear();
      } else {
        failed(error);
        setBusy(false);
      }
    }
  }
  const current = trail.at(-1);
  return (
    <div className="public-shell">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span>
          Nextcloud Flare<small>共有リンク</small>
        </span>
        {root && (
          <button
            className="quiet"
            disabled={busy || transferBusy || editState.running}
            onClick={() => void logout()}
          >
            共有を閉じる
          </button>
        )}
      </header>
      <main aria-busy={busy}>
        <p className="eyebrow">SHARED WITH YOU</p>
        <h1>{root?.kind === "upload_only" ? "ファイルを送信" : current?.name || "共有ファイル"}</h1>
        <p className="description">
          {root?.kind === "upload_only"
            ? "ファイルを選択して送信してください。送信状況を確認し、完了後に受付番号を受け取れます。"
            : root
              ? root.permissions.upload || root.permissions.overwrite
                ? root.root.kind === "file"
                  ? "共有されたファイルの閲覧・保存と、確認付きの上書きができます。"
                  : "共有されたファイルの閲覧・保存、アップロードと編集ができます。"
                : root.root.kind !== "file" &&
                    (root.permissions.createFolder || root.permissions.rename)
                  ? "共有されたファイルの閲覧・保存、フォルダー作成と名前変更ができます。"
                  : "共有されたファイルを閲覧・保存できます。"
              : "リンクを受け取った方のためのファイル共有です。"}
        </p>
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {busy && (
          <p role="status" className="loading">
            読み込み中…
          </p>
        )}
        {!root && !closed && !busy && (
          <form
            className="unlock"
            onSubmit={(event) => {
              event.preventDefault();
              void open(password);
            }}
          >
            <label htmlFor="password">共有パスワード</label>
            <input
              id="password"
              type="password"
              autoComplete="off"
              value={password}
              maxLength={1024}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby="password-hint"
            />
            <p id="password-hint">パスワードが設定されていない場合は、空欄のまま開いてください。</p>
            <button className="primary" disabled={retry > 0} type="submit">
              {retry ? `${retry}秒後に再試行できます` : "共有を開く"}
            </button>
          </form>
        )}
        {root?.kind === "upload_only" && (
          <>
            <button
              className="primary"
              disabled={locked}
              onClick={() => {
                setMessage("");
                setUploading({});
              }}
            >
              ファイルを選んで送信
            </button>
            <PublicUploads
              client={client}
              root={root}
              parentId={null}
              request={uploading}
              closeForm={() => setUploading(null)}
              busyChanged={setTransferBusy}
              changed={setMessage}
              denied={(error) => {
                setUploading(null);
                setTransferBusy(false);
                setRoot(null);
                failed(error);
              }}
            />
          </>
        )}
        {root && root.kind !== "upload_only" && (
          <>
            <nav aria-label="共有フォルダーの階層" className="breadcrumbs">
              {trail.map((node, index) => (
                <span key={node.id}>
                  {index > 0 && <span aria-hidden="true"> / </span>}
                  <button
                    disabled={locked || index === trail.length - 1}
                    onClick={() => void browse(trail.slice(0, index + 1))}
                  >
                    {node.name || "共有フォルダー"}
                  </button>
                </span>
              ))}
            </nav>
            {current && (
              <PublicEditor
                key={root.sessionId}
                client={client}
                sessionId={root.sessionId}
                expiresAt={root.expiresAt}
                parentId={current.id}
                request={editing}
                statusChanged={setEditState}
                close={() => setEditing(null)}
                done={(notice) => {
                  setEditing(null);
                  if (current.kind === "file") void open("", notice);
                  else void browse(trail, undefined, notice);
                }}
                failed={(error) => {
                  setEditing(null);
                  setRoot(null);
                  setTrail([]);
                  setPage(null);
                  failed(error);
                  setMessage(
                    "共有の状態が変わったため、操作を確認できませんでした。共有リンクを開き直し、フォルダーの内容を確認してください。",
                  );
                }}
              />
            )}
            {current && (
              <PublicUploads
                client={client}
                root={root}
                parentId={current.kind === "file" ? null : current.id}
                request={uploading}
                closeForm={() => setUploading(null)}
                busyChanged={setTransferBusy}
                changed={(notice) => {
                  if (current.kind === "file") void open("", notice);
                  else void browse(trail, undefined, notice);
                }}
                denied={(error) => {
                  setUploading(null);
                  setTransferBusy(false);
                  setRoot(null);
                  setTrail([]);
                  setPage(null);
                  failed(error);
                  setMessage(
                    "共有の状態や上書き先が変わりました。共有リンクを開き直し、現在の内容を確認してください。",
                  );
                }}
              />
            )}
            <div className="list-header">
              <span>{current?.kind === "file" ? "ファイル" : "フォルダー内の項目"}</span>
              {current && current.kind !== "file" && (
                <button
                  className="quiet"
                  disabled={locked}
                  aria-label="このフォルダーをZIPで保存"
                  onClick={() => void download(current)}
                >
                  ZIPで保存
                </button>
              )}
              {current?.kind !== "file" && root.permissions.createFolder && (
                <button
                  className="quiet"
                  disabled={editLocked}
                  onClick={() => {
                    setMessage("");
                    setEditing({});
                  }}
                >
                  新規フォルダー
                </button>
              )}
              {current?.kind !== "file" && root.permissions.upload && (
                <button
                  className="quiet"
                  disabled={editLocked}
                  onClick={() => {
                    setMessage("");
                    setUploading({});
                  }}
                >
                  アップロード
                </button>
              )}
              <button className="quiet" disabled={locked} onClick={() => void open("")}>
                更新
              </button>
            </div>
            <ul className="file-list">
              {(current?.kind === "file" ? [current] : (page?.children ?? [])).map((node) => (
                <li key={node.id}>
                  <span
                    className={`file-icon ${node.kind === "file" ? "document" : "folder"}`}
                    aria-hidden="true"
                  >
                    {node.kind === "file" ? "↓" : "▰"}
                  </span>
                  <div className="file-info">
                    {node.kind === "file" ? (
                      <span className="filename">{node.name}</span>
                    ) : (
                      <button
                        className="folder-name"
                        disabled={locked}
                        onClick={() => void browse([...trail, node])}
                      >
                        {node.name}
                      </button>
                    )}
                    <small>{node.kind === "file" ? size(node.size) : "フォルダー"}</small>
                  </div>
                  {root.permissions.rename && node.id !== root.root.id && (
                    <button
                      className="rename"
                      disabled={editLocked}
                      aria-label={`${node.name}の名前を変更`}
                      onClick={() => {
                        setMessage("");
                        setEditing({ node });
                      }}
                    >
                      名前を変更
                    </button>
                  )}
                  {node.kind === "file" && root.permissions.overwrite && (
                    <button
                      className="rename"
                      disabled={editLocked || !node.currentBlobId}
                      aria-label={`${node.name}を上書き`}
                      onClick={() => {
                        setMessage("");
                        setUploading({ node });
                      }}
                    >
                      上書き
                    </button>
                  )}
                  {root.permissions.delete && node.id !== root.root.id && (
                    <button
                      className="rename"
                      disabled={editLocked}
                      aria-label={`${node.name}をごみ箱へ移動`}
                      onClick={() => {
                        setMessage("");
                        setEditing({ node, remove: true });
                      }}
                    >
                      ごみ箱へ移動
                    </button>
                  )}
                  {node.kind !== "file" && (
                    <button
                      className="download"
                      disabled={locked}
                      onClick={() => void download(node)}
                      aria-label={`${node.name}をZIPで保存`}
                    >
                      ZIPで保存 <span aria-hidden="true">↓</span>
                    </button>
                  )}
                  {node.kind === "file" && (
                    <button
                      className="download"
                      disabled={locked || !node.currentBlobId}
                      onClick={() => void download(node)}
                      aria-label={`${node.name}を開く・保存`}
                    >
                      開く・保存 <span aria-hidden="true">↗</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!busy && current?.kind !== "file" && page?.children.length === 0 && (
              <p className="empty">このフォルダーは空です。</p>
            )}
            {page?.nextCursor && (
              <button
                className="load-more"
                disabled={locked}
                onClick={() => void browse(trail, page.nextCursor)}
              >
                続きを表示
              </button>
            )}
          </>
        )}
      </main>
      <footer>Nextcloud Flare · 安心してファイルを共有</footer>
    </div>
  );
}
