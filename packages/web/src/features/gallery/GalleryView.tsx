import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GalleryItem } from "@ncf/shared";

import { t } from "../../i18n";
import { api } from "../../lib/api";

interface HeaderBlock {
  kind: "header";
  key: string;
  label: string;
  y: number;
  height: number;
}

interface RowBlock {
  kind: "row";
  key: string;
  items: { item: GalleryItem; width: number }[];
  y: number;
  height: number;
}

type LayoutBlock = HeaderBlock | RowBlock;

function dateLabel(item: GalleryItem): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    item.takenAt ?? item.capturedAt,
  );
}

function aspect(item: GalleryItem): number {
  if (item.width === null || item.height === null || item.height === 0) return 4 / 3;
  return Math.max(0.5, Math.min(2.5, item.width / item.height));
}

function layout(items: GalleryItem[], width: number): { blocks: LayoutBlock[]; height: number } {
  const blocks: LayoutBlock[] = [];
  const available = Math.max(280, width - 2);
  let y = 0;
  let index = 0;
  while (index < items.length) {
    const first = items[index];
    if (first === undefined) break;
    const label = dateLabel(first);
    blocks.push({ kind: "header", key: `header-${label}`, label, y, height: 48 });
    y += 48;
    const group: GalleryItem[] = [];
    let candidate = items[index];
    while (candidate !== undefined && dateLabel(candidate) === label) {
      group.push(candidate);
      index += 1;
      candidate = items[index];
    }
    let row: GalleryItem[] = [];
    let sum = 0;
    for (const item of group) {
      row.push(item);
      sum += aspect(item);
      if (sum * 210 >= available) {
        const gaps = Math.max(0, row.length - 1) * 8;
        const height = Math.max(140, Math.min(260, (available - gaps) / sum));
        blocks.push({
          kind: "row",
          key: `row-${row[0]?.id ?? y}`,
          items: row.map((entry) => ({ item: entry, width: aspect(entry) * height })),
          y,
          height,
        });
        y += height + 8;
        row = [];
        sum = 0;
      }
    }
    if (row.length > 0) {
      const height = 180;
      blocks.push({
        kind: "row",
        key: `row-${row[0]?.id ?? y}`,
        items: row.map((entry) => ({ item: entry, width: aspect(entry) * height })),
        y,
        height,
      });
      y += height + 8;
    }
    y += 20;
  }
  return { blocks, height: y };
}

interface LightboxProps {
  items: GalleryItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

function Lightbox({ items, index, onIndex, onClose }: LightboxProps): React.JSX.Element {
  const item = items[index];
  const [zoom, setZoom] = useState(1);
  const [playing, setPlaying] = useState(false);

  const move = useCallback(
    (offset: number) => {
      if (items.length === 0) return;
      onIndex((index + offset + items.length) % items.length);
      setZoom(1);
    },
    [index, items.length, onIndex],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") move(-1);
      else if (event.key === "ArrowRight") move(1);
      else if (event.key === "+" || event.key === "=")
        setZoom((value) => Math.min(4, value + 0.25));
      else if (event.key === "-") setZoom((value) => Math.max(0.5, value - 0.25));
      else if (event.key.toLowerCase() === "s") setPlaying((value) => !value);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [move, onClose]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => move(1), 3500);
    return () => window.clearInterval(timer);
  }, [move, playing]);

  if (item === undefined) return <></>;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--overlay)] text-[var(--overlay-fg)] backdrop-blur-xl">
      <header className="flex h-16 items-center gap-3 border-b border-white/10 px-4">
        <button className="icon-button border-white/10 text-[var(--overlay-fg)]" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.name}</p>
          <p className="text-xs text-[var(--overlay-fg)]/80">
            {index + 1} {t("gallery.of")} {items.length} · {dateLabel(item)}
          </p>
        </div>
        {item.mediaKind === "image" && (
          <>
            <button
              className="icon-button border-white/10 text-[var(--overlay-fg)]"
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="w-12 text-center text-xs text-[var(--overlay-fg)]/80">
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="icon-button border-white/10 text-[var(--overlay-fg)]"
              onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </>
        )}
        <button
          className="icon-button border-white/10 text-[var(--overlay-fg)]"
          onClick={() => setPlaying((value) => !value)}
          title={`${t("gallery.slideshow")} (S)`}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <button
          className="absolute left-4 z-10 grid h-12 w-12 place-items-center rounded-full bg-black/40 transition hover:bg-black/70"
          onClick={() => move(-1)}
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        {item.mediaKind === "video" ? (
          <video
            className="max-h-full max-w-full"
            controls
            autoPlay
            key={item.id}
            preload="metadata"
            src={item.contentUrl}
          />
        ) : (
          <img
            alt={item.name}
            className="max-h-full max-w-full select-none object-contain transition-transform duration-200"
            draggable={false}
            onWheel={(event) => {
              event.preventDefault();
              setZoom((value) =>
                Math.max(0.5, Math.min(4, value + (event.deltaY < 0 ? 0.2 : -0.2))),
              );
            }}
            src={item.contentUrl}
            style={{ transform: `scale(${zoom})` }}
          />
        )}
        <button
          className="absolute right-4 z-10 grid h-12 w-12 place-items-center rounded-full bg-black/40 transition hover:bg-black/70"
          onClick={() => move(1)}
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}

export function GalleryView({ rootId }: { rootId: string }): React.JSX.Element {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(900);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [selected, setSelected] = useState<number | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api
      .path(rootId)
      .then((response) => setFolderPath(response.items.map((item) => item.name).join(" / ")))
      .catch(() => setFolderPath(null));
  }, [rootId]);

  const load = useCallback(
    async (next?: string) => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.gallery(rootId, recursive, next);
        setItems((current) => (next === undefined ? page.items : [...current, ...page.items]));
        setCursor(page.nextCursor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("gallery.loadError"));
      } finally {
        setLoading(false);
      }
    },
    [loading, recursive, rootId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
  }, [recursive, rootId]);

  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gallery = useMemo(() => layout(items, width), [items, width]);
  const visible = gallery.blocks.filter(
    (block) =>
      block.y + block.height >= scrollTop - 700 && block.y <= scrollTop + viewportHeight + 700,
  );

  useEffect(() => {
    if (
      cursor !== null &&
      !loading &&
      gallery.height > 0 &&
      scrollTop + viewportHeight > gallery.height - 700
    ) {
      void load(cursor);
    }
  }, [cursor, gallery.height, load, loading, scrollTop, viewportHeight]);

  return (
    <section className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 backdrop-blur-xl sm:px-8">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 text-[var(--overlay-fg)] shadow-lg shadow-violet-500/20">
          <ImageIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[.18em] text-violet-600 dark:text-violet-400">
            {t("gallery.media")}
          </p>
          <h2 className="text-xl font-semibold tracking-tight">{t("gallery.title")}</h2>
          {folderPath !== null && (
            <p className="truncate text-xs text-[var(--fg-muted)]">{folderPath}</p>
          )}
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-white/10">
          <input
            checked={recursive}
            onChange={(event) => setRecursive(event.target.checked)}
            type="checkbox"
          />
          {t("gallery.include")}
        </label>
        <button className="icon-button" onClick={() => void load()} title={t("gallery.refresh")}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div
        className="relative min-h-0 flex-1 overflow-y-auto px-3 sm:px-6"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        ref={viewport}
      >
        {error !== null && (
          <div className="mx-auto mt-8 max-w-xl rounded-2xl bg-red-500/10 p-4 text-sm text-red-500">
            {error}
          </div>
        )}
        {items.length === 0 && !loading && error === null && (
          <div className="grid h-[70vh] place-items-center text-center">
            <div>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-violet-500/10 text-violet-500">
                <Search className="h-7 w-7" />
              </div>
              <h3 className="mt-5 font-medium">{t("gallery.emptyTitle")}</h3>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("gallery.emptyBody")}</p>
            </div>
          </div>
        )}
        <div className="relative" style={{ height: gallery.height }}>
          {visible.map((block) =>
            block.kind === "header" ? (
              <div
                className="absolute left-0 right-0 flex items-end pb-3 text-sm font-semibold"
                key={block.key}
                style={{ height: block.height, top: block.y }}
              >
                {block.label}
              </div>
            ) : (
              <div
                className="absolute left-0 right-0 flex gap-2 overflow-hidden"
                key={block.key}
                style={{ height: block.height, top: block.y }}
              >
                {block.items.map(({ item, width: itemWidth }) => (
                  <button
                    className="group relative h-full shrink-0 overflow-hidden rounded-xl bg-slate-200 text-left shadow-sm dark:bg-white/5"
                    key={item.id}
                    onClick={() =>
                      setSelected(items.findIndex((candidate) => candidate.id === item.id))
                    }
                    style={{ width: itemWidth }}
                  >
                    <img
                      alt={item.name}
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      loading="lazy"
                      src={item.thumbUrl}
                    />
                    {item.mediaKind === "video" && (
                      <span className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-[var(--overlay-fg)] backdrop-blur">
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-10 text-xs font-medium text-[var(--overlay-fg)] opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
                      {item.name}
                    </span>
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
        {loading && (
          <div className="sticky bottom-5 mx-auto flex w-fit items-center gap-2 rounded-full bg-[var(--surface)] px-4 py-2 text-xs text-[var(--fg)] shadow-xl">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("gallery.loading")}
          </div>
        )}
      </div>

      {selected !== null && (
        <Lightbox
          index={selected}
          items={items}
          onClose={() => setSelected(null)}
          onIndex={setSelected}
        />
      )}
    </section>
  );
}
