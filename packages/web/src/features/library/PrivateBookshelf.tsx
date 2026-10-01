import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type Account,
  ApiError,
  api,
  errorMessage,
  type FileNode,
  formatBytes,
  type LibraryPublication,
  type PreparedContentSession,
} from "../../lib/api";
import { type DebouncedWriter, debouncedWriter } from "../../lib/mediaResume";

const BOOK_EXTENSIONS = ["epub", "pdf", "cbz", "cbr", "rar", "7z"] as const;

function extension(name: string) {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}

function chapterText(markup: string): string {
  const parsed = new DOMParser().parseFromString(markup, "application/xhtml+xml");
  if (parsed.querySelector("parsererror")) throw new Error("invalid_epub_chapter");
  const body = parsed.querySelector("body");
  if (!body) throw new Error("invalid_epub_chapter");
  const blocks = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre")]
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter(Boolean);
  const text = (blocks.length ? blocks.join("\n\n") : (body.textContent ?? "")).trim();
  if (!text) throw new Error("empty_epub_chapter");
  return text;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readerDocument(text: string, size: number, theme: "light" | "sepia" | "dark") {
  const colors = {
    light: ["#ffffff", "#283446"],
    sepia: ["#f7f0df", "#554936"],
    dark: ["#17202d", "#e6ebf2"],
  }[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html{background:${colors[0]};color:${colors[1]}}body{max-width:48rem;margin:0 auto;padding:3rem 2rem;font:${size}px/1.9 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){body{padding:1.5rem 1rem}}</style></head><body>${escapeHtml(text)}</body></html>`;
}

export function PrivateBookshelf({ account }: { account: Account }) {
  const candidates = useQuery({
    queryKey: ["bookshelf", account.id, account.epoch, account.rootNodeId],
    queryFn: ({ signal }) => api.filesByExtensions(account.rootNodeId, BOOK_EXTENSIONS, signal),
  });
  const [selected, setSelected] = useState<FileNode | null>(null);
  const publication = useQuery({
    queryKey: [
      "epub-publication",
      account.id,
      account.epoch,
      selected?.id,
      selected?.currentBlobId,
    ],
    queryFn: ({ signal }) => api.library(selected!.id, signal),
    enabled: selected !== null && extension(selected.name) === "epub",
  });
  const readingState = useQuery({
    queryKey: [
      "epub-reading-state",
      account.id,
      account.epoch,
      selected?.id,
      selected?.currentBlobId,
    ],
    queryFn: ({ signal }) => api.readingState(selected!.id, signal),
    enabled: selected !== null && extension(selected.name) === "epub",
  });
  const [chapter, setChapter] = useState(0);
  const [chapterContent, setChapterContent] = useState("");
  const [chapterError, setChapterError] = useState("");
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [chapterAttempt, setChapterAttempt] = useState(0);
  const [fontSize, setFontSize] = useState(17);
  const [theme, setTheme] = useState<"light" | "sepia" | "dark">("light");
  const activeSession = useRef<PreparedContentSession | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const chapterRef = useRef(0);
  const restoredBlob = useRef<string | null>(null);
  const restoredProgress = useRef(0);
  const latestReading = useRef({ spineIndex: 0, progress: 0 });
  const writer = useRef<DebouncedWriter<{ spineIndex: number; progress: number }> | null>(null);

  const frameProgress = () => {
    const scrolling = frame.current?.contentDocument?.scrollingElement;
    if (!scrolling) return 0;
    const maximum = scrolling.scrollHeight - scrolling.clientHeight;
    return maximum <= 0 ? 0 : Math.round((scrolling.scrollTop / maximum) * 10_000);
  };

  const flushReading = () => {
    const position = {
      spineIndex: chapterRef.current,
      progress: frame.current ? frameProgress() : latestReading.current.progress,
    };
    latestReading.current = position;
    void writer.current?.flush(position).catch(() => undefined);
  };

  const changeChapter = (next: number) => {
    flushReading();
    chapterRef.current = next;
    restoredProgress.current = 0;
    latestReading.current = { spineIndex: next, progress: 0 };
    setChapter(next);
    writer.current?.schedule(latestReading.current);
  };

  useEffect(() => {
    chapterRef.current = 0;
    restoredBlob.current = null;
    restoredProgress.current = 0;
    latestReading.current = { spineIndex: 0, progress: 0 };
    setChapter(0);
    setChapterContent("");
    setChapterError("");
  }, [selected?.id, selected?.currentBlobId]);

  useEffect(() => {
    const book = selected;
    const metadata = publication.data;
    const state = readingState.data;
    if (
      !book?.currentBlobId ||
      !metadata ||
      restoredBlob.current === book.currentBlobId ||
      state?.nodeId !== book.id ||
      state.blobId !== book.currentBlobId ||
      state.position === null ||
      state.pageCount !== metadata.pageCount ||
      state.position.spineIndex >= metadata.spine.length
    )
      return;
    restoredBlob.current = book.currentBlobId;
    restoredProgress.current = state.position.progress;
    chapterRef.current = state.position.spineIndex;
    latestReading.current = state.position;
    setChapter(state.position.spineIndex);
  }, [publication.data, readingState.data, selected]);

  useEffect(() => {
    const book = selected;
    const metadata = publication.data;
    const blobId = book?.currentBlobId;
    if (!book || !blobId || !metadata) return;
    const active = debouncedWriter<{ spineIndex: number; progress: number }>(
      ({ spineIndex, progress }) => api.writeReadingState(book.id, blobId, spineIndex, progress),
    );
    writer.current = active;
    return () => {
      void active.flush(latestReading.current).catch(() => undefined);
      active.clear();
      if (writer.current === active) writer.current = null;
    };
  }, [publication.data, selected]);

  useEffect(() => {
    const book = selected;
    const metadata = publication.data;
    const token = metadata?.spine[chapter];
    if (!book?.currentBlobId || !metadata || !token) return;
    const blobId = book.currentBlobId;
    const controller = new AbortController();
    let session: PreparedContentSession | null = null;
    setLoadingChapter(true);
    setChapterContent("");
    setChapterError("");
    void (async () => {
      session = await api.prepareContentSession(
        account,
        [{ id: book.id, currentBlobId: blobId }],
        "page",
        controller.signal,
      );
      const response = await fetch(session.url({ id: book.id, currentBlobId: blobId }, token), {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new ApiError(response.status, "epub_entry_failed");
      const text = chapterText(await response.text());
      controller.signal.throwIfAborted();
      activeSession.current = session;
      setChapterContent(text);
    })()
      .catch((error) => {
        if (!controller.signal.aborted) {
          if (session) {
            void session.cancel().catch(() => undefined);
            if (activeSession.current === session) activeSession.current = null;
          }
          setChapterError(
            error instanceof ApiError && [401, 403, 404].includes(error.status)
              ? "読書セッションが失効したか、本が更新されました。章を読み直してください。"
              : errorMessage(error),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingChapter(false);
      });
    return () => {
      controller.abort();
      const stale = session ?? activeSession.current;
      if (activeSession.current === stale) activeSession.current = null;
      if (stale) void stale.cancel().catch(() => undefined);
    };
  }, [account, chapter, chapterAttempt, publication.data, selected]);

  useEffect(
    () => () => {
      if (activeSession.current) void activeSession.current.cancel().catch(() => undefined);
    },
    [],
  );

  const items = candidates.data?.items ?? [];
  const selectedSupported = selected && extension(selected.name) === "epub";
  const srcDoc = useMemo(
    () => (chapterContent ? readerDocument(chapterContent, fontSize, theme) : ""),
    [chapterContent, fontSize, theme],
  );

  if (candidates.isPending)
    return (
      <div className="empty-state">
        <LoaderCircle size={30} className="spin" />
        <p>本棚を読み込んでいます</p>
      </div>
    );
  if (candidates.error)
    return (
      <div className="empty-state">
        <BookOpen size={44} strokeWidth={1.3} />
        <h2>本棚を開けません</h2>
        <p>{errorMessage(candidates.error)}</p>
        <Button onClick={() => void candidates.refetch()}>
          <RefreshCw size={16} />
          読み直す
        </Button>
      </div>
    );
  if (!items.length)
    return (
      <div className="empty-state">
        <BookOpen size={48} strokeWidth={1.3} />
        <h2>本棚は空です</h2>
        <p>EPUB をアップロードすると、ここから読めます。</p>
      </div>
    );

  return (
    <>
      <div className="media-toolbar">
        <span>
          <strong>{items.length}</strong> 冊{candidates.data?.truncated && "以上"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="本棚を更新"
          onClick={() => void candidates.refetch()}
        >
          <RefreshCw size={17} className={candidates.isFetching ? "spin" : ""} />
        </Button>
      </div>
      {candidates.data?.truncated && (
        <div className="notice" role="status">
          本棚は検索上限まで表示しています。フォルダーを整理すると見つけやすくなります。
        </div>
      )}
      <div className="bookshelf-grid">
        {items.map((item) => {
          const supported = extension(item.name) === "epub";
          return (
            <button
              className="book-card"
              key={item.id}
              onClick={() => setSelected(item)}
              aria-label={`${item.name}を開く`}
            >
              <span className="book-cover">
                <BookOpen size={38} strokeWidth={1.25} />
                <small>{extension(item.name).toUpperCase()}</small>
              </span>
              <span>
                <strong title={item.name}>{item.name}</strong>
                <small>
                  {supported ? "EPUB リーダー" : "この形式はリーダー非対応"} ·{" "}
                  {formatBytes(item.size)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="reader-shell" role="dialog" aria-modal="true" aria-label={selected.name}>
          <header className="reader-header">
            <div>
              <strong>{publication.data?.title ?? selected.name}</strong>
              <span>{publication.data?.author ?? "著者情報なし"}</span>
            </div>
            <div className="reader-tools">
              <Button
                variant="ghost"
                size="icon"
                aria-label="文字を小さく"
                disabled={fontSize <= 13}
                onClick={() => setFontSize((value) => value - 1)}
              >
                <Minus size={17} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="文字を大きく"
                disabled={fontSize >= 24}
                onClick={() => setFontSize((value) => value + 1)}
              >
                <Plus size={17} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="読書テーマを変更"
                onClick={() =>
                  setTheme((value) =>
                    value === "light" ? "sepia" : value === "sepia" ? "dark" : "light",
                  )
                }
              >
                {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="リーダーを閉じる"
                onClick={() => setSelected(null)}
              >
                <X size={21} />
              </Button>
            </div>
          </header>
          {!selectedSupported ? (
            <div className="reader-message">
              <BookOpen size={42} strokeWidth={1.3} />
              <h2>この本はリーダーで開けません</h2>
              <p>現在は安全性を確認できた reflow 型 EPUB のみ対応しています。</p>
            </div>
          ) : publication.isPending ? (
            <div className="reader-message">
              <LoaderCircle size={30} className="spin" />
              <p>本の情報を読み込んでいます</p>
            </div>
          ) : publication.error ? (
            <div className="reader-message">
              <BookOpen size={42} strokeWidth={1.3} />
              <h2>この EPUB は開けません</h2>
              <p>暗号化、固定レイアウト、スクリプト、破損した書庫は対応していません。</p>
              <Button onClick={() => void publication.refetch()}>情報を読み直す</Button>
            </div>
          ) : publication.data ? (
            <div className="reader-layout">
              <nav className="reader-toc" aria-label="目次">
                <strong>目次</strong>
                {publication.data.spine.map((token, index) => (
                  <button
                    key={token}
                    aria-current={chapter === index ? "page" : undefined}
                    onClick={() => changeChapter(index)}
                  >
                    第 {index + 1} 章
                  </button>
                ))}
              </nav>
              <main className="reader-page">
                <div className="reader-paging">
                  <Button
                    size="small"
                    disabled={chapter <= 0}
                    onClick={() => changeChapter(chapterRef.current - 1)}
                  >
                    <ChevronLeft size={16} />
                    前の章
                  </Button>
                  <span>
                    {chapter + 1} / {publication.data.pageCount}
                  </span>
                  <Button
                    size="small"
                    disabled={chapter >= publication.data.spine.length - 1}
                    onClick={() => changeChapter(chapterRef.current + 1)}
                  >
                    次の章
                    <ChevronRight size={16} />
                  </Button>
                </div>
                {loadingChapter ? (
                  <div className="reader-message">
                    <LoaderCircle size={28} className="spin" />
                    <p>章を読み込んでいます</p>
                  </div>
                ) : chapterError ? (
                  <div className="reader-message" role="alert">
                    <p>{chapterError}</p>
                    <Button onClick={() => setChapterAttempt((value) => value + 1)}>
                      章を読み直す
                    </Button>
                  </div>
                ) : (
                  srcDoc && (
                    <iframe
                      ref={frame}
                      className="reader-frame"
                      sandbox="allow-same-origin"
                      srcDoc={srcDoc}
                      title={`${publication.data.title ?? selected.name} 第${chapter + 1}章`}
                      onLoad={(event) => {
                        const scrolling = event.currentTarget.contentDocument?.scrollingElement;
                        if (!scrolling) return;
                        const progress = restoredProgress.current;
                        const maximum = scrolling.scrollHeight - scrolling.clientHeight;
                        if (progress > 0 && maximum > 0)
                          scrolling.scrollTop = Math.round((maximum * progress) / 10_000);
                        restoredProgress.current = 0;
                        event.currentTarget.contentWindow?.addEventListener(
                          "scroll",
                          () => {
                            latestReading.current = {
                              spineIndex: chapterRef.current,
                              progress: frameProgress(),
                            };
                            writer.current?.schedule(latestReading.current);
                          },
                          { passive: true },
                        );
                      }}
                    />
                  )
                )}
              </main>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
