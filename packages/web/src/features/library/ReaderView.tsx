import type { EpubEntrySummary, LibraryItemSummary, ReadingMode } from "@ncf/shared";
import { BookOpen, ChevronLeft, ChevronRight, Columns2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

interface ReaderViewProps {
  item: LibraryItemSummary;
  onClose: () => void;
}

export function ReaderView({ item: initialItem, onClose }: ReaderViewProps): React.JSX.Element {
  const [item, setItem] = useState(initialItem);
  const [entries, setEntries] = useState<EpubEntrySummary[]>([]);
  const [page, setPage] = useState(initialItem.readingState?.page ?? 0);
  const [mode, setMode] = useState<ReadingMode>(initialItem.readingState?.mode ?? "single");
  const [rtl, setRtl] = useState(initialItem.readingState?.rtl ?? false);
  const [xhtml, setXhtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pointerStart = useRef<number | null>(null);
  const pageCount = item.pageCount ?? entries.length;
  const step = mode === "spread" ? 2 : 1;

  const visiblePages = useMemo(() => {
    const pages = mode === "spread" && page + 1 < pageCount ? [page, page + 1] : [page];
    return rtl ? pages.reverse() : pages;
  }, [mode, page, pageCount, rtl]);

  const move = (offset: number) => {
    setPage((current) => Math.max(0, Math.min(Math.max(0, pageCount - 1), current + offset)));
  };

  useEffect(() => {
    api
      .libraryItem(item.id)
      .then((response) => {
        setItem(response.item);
        setEntries(response.entries);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("library.readerError")),
      );
  }, [item.id]);

  useEffect(() => {
    if (item.kind !== "epub") return;
    const entry = entries[page];
    if (entry === undefined) return;
    api
      .epubEntry(item.id, entry.id)
      .then(setXhtml)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("library.readerError")),
      );
  }, [entries, item.id, item.kind, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api.saveReadingState(item.id, {
        page,
        mode,
        rtl,
        ...(entries[page] === undefined ? {} : { entryId: entries[page].id }),
        ...(item.kind === "epub" ? { cfi: `epubcfi(/6/${page * 2 + 2})` } : {}),
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [entries, item.id, item.kind, mode, page, rtl]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") move(rtl ? step : -step);
      else if (event.key === "ArrowRight") move(rtl ? -step : step);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose, rtl, step]);

  useEffect(() => {
    const contentWindow = frame.current?.contentWindow;
    if (xhtml === null || contentWindow == null) return;
    contentWindow.postMessage(
      {
        type: "ncf-reader-load",
        title: entries[page]?.title ?? item.title,
        xhtml,
        cfi: item.readingState?.cfi,
      },
      window.location.origin,
    );
  }, [entries, item.readingState?.cfi, item.title, page, xhtml]);

  const previous = rtl ? step : -step;
  const next = rtl ? -step : step;

  return (
    <section
      className="fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] text-[var(--fg)]"
      onPointerDown={(event) => {
        pointerStart.current = event.clientX;
      }}
      onPointerUp={(event) => {
        if (pointerStart.current === null) return;
        const distance = event.clientX - pointerStart.current;
        pointerStart.current = null;
        if (Math.abs(distance) > 60) move(distance < 0 ? next : previous);
      }}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <button className="icon-button" onClick={onClose} aria-label={t("library.closeReader")}>
          <X className="h-4 w-4" />
        </button>
        <BookOpen className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</h2>
        {item.kind === "epub" && entries.length > 0 && (
          <select
            className="max-w-48 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs"
            aria-label={t("library.toc")}
            value={page}
            onChange={(event) => setPage(Number(event.target.value))}
          >
            {entries.map((entry, index) => (
              <option key={entry.id} value={index}>
                {entry.title}
              </option>
            ))}
          </select>
        )}
        <button
          className={`rounded-lg border border-[var(--border)] px-3 py-2 text-xs ${mode === "spread" ? "bg-[var(--surface-hover)]" : ""}`}
          onClick={() => setMode((current) => (current === "single" ? "spread" : "single"))}
        >
          <Columns2 className="mr-1 inline h-3.5 w-3.5" />
          {mode === "single" ? t("library.single") : t("library.spread")}
        </button>
        <button
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
          onClick={() => setRtl((current) => !current)}
        >
          {rtl ? t("library.rtl") : t("library.ltr")}
        </button>
        <span className="min-w-20 text-right text-xs text-[var(--fg-muted)]">
          {Math.min(page + 1, pageCount)} / {pageCount}
        </span>
      </header>
      {error !== null && (
        <p className="m-3 rounded-xl bg-rose-500/10 p-3 text-sm text-[var(--danger)]">{error}</p>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        <button
          className="icon-button absolute left-3 z-10 bg-[var(--surface)]"
          onClick={() => move(previous)}
          disabled={page === 0}
          aria-label={t("library.previous")}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {item.kind === "cbz" ? (
          <div className={`flex h-full max-w-full gap-2 ${rtl ? "flex-row-reverse" : ""}`}>
            {visiblePages.map((pageNumber) => (
              <img
                key={pageNumber}
                alt={`${item.title} ${pageNumber + 1}`}
                className="h-full max-w-[48vw] object-contain"
                src={api.libraryPageUrl(item.id, pageNumber)}
              />
            ))}
          </div>
        ) : item.kind === "epub" ? (
          <iframe
            ref={frame}
            className="h-full w-full border-0"
            src={`/reader/index.html?parentOrigin=${encodeURIComponent(window.location.origin)}`}
            title={item.title}
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => {
              if (xhtml === null) return;
              frame.current?.contentWindow?.postMessage(
                {
                  type: "ncf-reader-load",
                  title: entries[page]?.title ?? item.title,
                  xhtml,
                  cfi: item.readingState?.cfi,
                },
                window.location.origin,
              );
            }}
          />
        ) : (
          <iframe
            className="h-full w-full border-0 bg-[var(--surface)]"
            src={`/api/v1/nodes/${encodeURIComponent(item.nodeId)}/content`}
            title={item.title}
          />
        )}
        <button
          className="icon-button absolute right-3 z-10 bg-[var(--surface)]"
          onClick={() => move(next)}
          disabled={page >= pageCount - step}
          aria-label={t("library.next")}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </section>
  );
}
