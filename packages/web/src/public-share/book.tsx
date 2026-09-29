import { useEffect, useRef, useState } from "react";
import { type BookClient, openBook } from "./bookClient";
import "./book.css";

export function BookReader({
  name,
  client,
  close,
  original,
  originalMessage,
}: {
  name: string;
  client: BookClient;
  close: () => void;
  original: () => void;
  originalMessage?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const [session, setSession] = useState<Awaited<ReturnType<typeof openBook>> | null>(null);
  const [page, setPage] = useState(1),
    [attempt, setAttempt] = useState(0),
    [message, setMessage] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, client.lifetime, AbortSignal.timeout(30000)]);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    setSession(null);
    setMessage("");
    setLoading(true);
    const expire = () => {
      setSession(null);
      setLoading(false);
      setMessage("閲覧期限が切れました。再読み込みすると続きを開けます。");
    };
    let expiresAt = 0;
    const visibility = () => {
      if (expiresAt && Date.now() >= expiresAt) expire();
    };
    const revoked = () => {
      setSession(null);
      setLoading(false);
      setMessage("閲覧を終了しました。ファイル一覧から開き直してください。");
    };
    client.lifetime.addEventListener("abort", revoked, { once: true });
    document.addEventListener("visibilitychange", visibility);
    void openBook(client, signal)
      .then((next) => {
        signal.throwIfAborted();
        expiresAt = next.expiresAt;
        setSession(next);
        setPage((p) => Math.min(p, next.book.pageCount));
        expiry = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
      })
      .catch(() => {
        if (!stop.signal.aborted) {
          setLoading(false);
          setMessage(
            "この書籍を開けません。索引の準備後に再読み込みするか、原本を開いてください。",
          );
        }
      });
    return () => {
      stop.abort();
      clearTimeout(expiry);
      client.lifetime.removeEventListener("abort", revoked);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, attempt]);
  const move = (next: number) => {
    if (!session || (next === page && !message)) return;
    setPage(Math.max(1, Math.min(next, session.book.pageCount)));
    setLoading(true);
    setMessage("");
  };
  return (
    <dialog
      ref={dialog}
      className="book-reader"
      aria-label={session?.book.title ?? name}
      onCancel={close}
    >
      <div className="book-heading">
        <div>
          <h2>{session?.book.title ?? name}</h2>
          <p>画像のページを順に読む</p>
        </div>
        <button type="button" aria-label="書籍を閉じる" onClick={close}>
          閉じる
        </button>
      </div>
      <div className="book-controls">
        <button type="button" disabled={!session || page === 1} onClick={() => move(page - 1)}>
          前のページ
        </button>
        <label>
          ページ{" "}
          <input
            type="number"
            aria-label="ページ番号"
            min={1}
            max={session?.book.pageCount ?? 1}
            value={page}
            disabled={!session}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isSafeInteger(next) && next >= 1 && next <= (session?.book.pageCount ?? 1))
                move(next);
            }}
          />
        </label>
        <span>/ {session?.book.pageCount ?? "—"}</span>
        <button
          type="button"
          disabled={!session || page === session.book.pageCount}
          onClick={() => move(page + 1)}
        >
          次のページ
        </button>
      </div>
      <div className="book-page" aria-busy={loading}>
        {loading && <p role="status">ページを読み込んでいます…</p>}
        {message && <p role="alert">{message}</p>}
        {session && !message && (
          <img
            key={`${session.url}:${page}:${attempt}`}
            src={`${session.url}${page}`}
            alt={`${page}ページ`}
            crossOrigin="use-credentials"
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setMessage(
                "このページを表示できません。再読み込みするか、別のページへ移動してください。",
              );
            }}
          />
        )}
      </div>
      <div className="book-controls">
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          再読み込み
        </button>
        {originalMessage && <p role="alert">{originalMessage}</p>}
        <button type="button" onClick={original}>
          原本を開く
        </button>
      </div>
    </dialog>
  );
}
