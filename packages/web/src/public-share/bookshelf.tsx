import { useEffect, useMemo, useState } from "react";
import type { LibraryItem, LibraryPage } from "../../../shared/src/library";
import { BookReader } from "./book";
import type { BookClient } from "./bookClient";
import "./bookshelf.css";

export interface BookshelfClient {
  readonly rootId: string;
  readonly lifetime: AbortSignal;
  list(cursor: string | null, signal: AbortSignal): Promise<LibraryPage>;
  book(item: LibraryItem): BookClient;
  original(item: LibraryItem, target: Window): Promise<void>;
}
const STATE = {
  folder: "フォルダー",
  pending: "索引の準備待ち",
  failed: "索引を作成できませんでした",
  unsupported: "この形式の閲覧には未対応です",
  original: "原本を開いて読めます",
  ready: "未読",
};
export function Bookshelf({
  client,
  folder,
}: {
  client: BookshelfClient;
  folder: (item: LibraryItem) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [book, setBook] = useState<LibraryItem | null>(null);
  const [originalMessage, setOriginalMessage] = useState("");
  const cursor = cursors.at(-1)!;
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, client.lifetime, AbortSignal.timeout(30000)]);
    setPage(null);
    setMessage("");
    void client
      .list(cursor, signal)
      .then((next) => {
        signal.throwIfAborted();
        if (next.rootId !== client.rootId || !Array.isArray(next.items) || next.items.length > 200)
          throw new Error("invalid_library_page");
        setPage(next);
      })
      .catch(() => {
        if (!stop.signal.aborted) setMessage("本棚を読み込めません。一覧を更新してください。");
      });
    const revoked = () => {
      setPage(null);
      setBook(null);
      setMessage("閲覧を終了しました。共有またはファイル一覧から開き直してください。");
    };
    client.lifetime.addEventListener("abort", revoked, { once: true });
    return () => {
      stop.abort();
      client.lifetime.removeEventListener("abort", revoked);
    };
  }, [client, cursor, attempt]);
  const reader = useMemo(() => (book ? client.book(book) : null), [client, book]);
  const original = async (item: LibraryItem) => {
    setOriginalMessage("");
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setOriginalMessage("原本を開くには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    try {
      await client.original(item, target);
    } catch {
      target.close();
      if (!client.lifetime.aborted)
        setOriginalMessage("原本を開けません。一覧を更新してください。");
    }
  };
  return (
    <section className="bookshelf" aria-label="本棚">
      <div className="bookshelf-heading">
        <div>
          <h2>本棚</h2>
          <p>このフォルダーの書籍 · 名前順</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setCursors([null]);
            setAttempt((n) => n + 1);
          }}
        >
          本棚を更新
        </button>
      </div>
      {message ? (
        <p role="alert">{message}</p>
      ) : !page ? (
        <p role="status">本棚を読み込んでいます…</p>
      ) : (
        <>
          {page.items.length === 0 && (
            <p>
              {page.nextCursor
                ? "この範囲には書籍がありません。次の範囲を確認できます。"
                : "このフォルダーに書籍はありません。ZIP・CBZ・EPUB・PDFを追加すると表示されます。"}
            </p>
          )}
          <ul className="bookshelf-items">
            {page.items.map((item) => (
              <li key={item.id}>
                <span className="bookshelf-format" aria-hidden="true">
                  {item.kind === "folder" ? "▤" : item.format.toUpperCase()}
                </span>
                <div className="bookshelf-description">
                  <h3>{item.title}</h3>
                  {item.title !== item.name && <p>{item.name}</p>}
                  {(item.author || item.series) && (
                    <p>{[item.author, item.series].filter(Boolean).join(" · ")}</p>
                  )}
                  <p>
                    {item.state === "ready"
                      ? `${item.pageCount}ページ · ${item.reading ? `${item.reading.page}ページまで読書` : "未読"}`
                      : STATE[item.state]}
                  </p>
                </div>
                <div className="bookshelf-actions">
                  {item.kind === "folder" ? (
                    <button
                      type="button"
                      onClick={() => folder(item)}
                      aria-label={`${item.name}の本棚を開く`}
                    >
                      フォルダーを開く
                    </button>
                  ) : (
                    <>
                      {item.state === "ready" && (
                        <button
                          type="button"
                          aria-label={`${item.title}を読む`}
                          onClick={() => {
                            setOriginalMessage("");
                            setBook(item);
                          }}
                        >
                          {item.reading ? "続きを読む" : "読む"}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`${item.name}の原本を開く`}
                        onClick={() => void original(item)}
                      >
                        原本を開く
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="bookshelf-pagination">
            <button
              type="button"
              disabled={cursors.length === 1}
              onClick={() => setCursors((values) => values.slice(0, -1))}
            >
              前の一覧
            </button>
            <span>{cursors.length}番目の一覧</span>
            <button
              type="button"
              disabled={!page.nextCursor}
              onClick={() =>
                page.nextCursor && setCursors((values) => [...values, page.nextCursor])
              }
            >
              次の一覧
            </button>
          </div>
        </>
      )}
      {originalMessage && !book && <p role="alert">{originalMessage}</p>}
      {book && reader && (
        <BookReader
          name={book.title}
          client={reader}
          close={() => {
            setBook(null);
            setAttempt((n) => n + 1);
          }}
          original={() => void original(book)}
          originalMessage={originalMessage}
        />
      )}
    </section>
  );
}
