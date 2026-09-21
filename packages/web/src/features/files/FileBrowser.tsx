import type { BreadcrumbItem, NodeSummary } from "@ncf/shared";
import {
  ChevronRight,
  Copy,
  Download,
  File,
  Folder,
  FolderInput,
  Grid2X2,
  History,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";
import { FileDetails } from "./FileDetails";
import { PreviewDialog } from "./PreviewDialog";
import { ShareDialog } from "./ShareDialog";

type ViewMode = "grid" | "list";

interface FileBrowserProps {
  rootId: string;
  refreshKey: number;
  onNavigate: (nodeId: string) => void;
  navigateTo: string | undefined;
}

interface MenuState {
  item: NodeSummary;
  x: number;
  y: number;
}

function iconFor(item: NodeSummary): React.JSX.Element {
  return item.kind === "folder" ? (
    <Folder className="h-8 w-8 fill-sky-400/15 text-sky-400" strokeWidth={1.5} />
  ) : (
    <File className="h-8 w-8 text-slate-400" strokeWidth={1.5} />
  );
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function FileBrowser({
  rootId,
  refreshKey,
  onNavigate,
  navigateTo,
}: FileBrowserProps): React.JSX.Element {
  const [currentId, setCurrentId] = useState(rootId);
  const [items, setItems] = useState<NodeSummary[]>([]);
  const [path, setPath] = useState<BreadcrumbItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewMode>(() =>
    localStorage.getItem("ncf-view") === "list" ? "list" : "grid",
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [detailsItem, setDetailsItem] = useState<NodeSummary | null>(null);
  const [shareItem, setShareItem] = useState<NodeSummary | null>(null);
  const [previewItem, setPreviewItem] = useState<NodeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dragged = useRef<string[]>([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [children, breadcrumbs] = await Promise.all([
        api.children(currentId),
        api.path(currentId),
      ]);
      setItems(children.items);
      setPath(breadcrumbs.items);
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    onNavigate(currentId);
    void load();
  }, [currentId, refreshKey]);

  useEffect(() => {
    if (navigateTo !== undefined) setCurrentId(navigateTo);
  }, [navigateTo]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const switchView = (next: ViewMode) => {
    setView(next);
    localStorage.setItem("ncf-view", next);
  };

  const select = (item: NodeSummary, event: React.MouseEvent) => {
    setSelected((current) => {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return new Set([item.id]);
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  const open = (item: NodeSummary) => {
    if (item.kind === "folder") setCurrentId(item.id);
    else setPreviewItem(item);
  };

  const createFolder = async () => {
    const name = window.prompt(t("files.folderName"));
    if (name === null || name.trim() === "") return;
    try {
      await api.createFolder(currentId, name.trim());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.createError"));
    }
  };

  const rename = async (item: NodeSummary) => {
    const name = window.prompt(t("files.rename"), item.name);
    if (name === null || name.trim() === "" || name === item.name) return;
    try {
      await api.rename(item.id, name.trim());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.renameError"));
    }
  };

  const trash = async (item: NodeSummary) => {
    try {
      await api.trashNode(item.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.trashError"));
    }
  };

  const copy = async (item: NodeSummary) => {
    try {
      await api.copy(item.id, currentId, `${item.name}（コピー）`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.copyError"));
    }
  };

  const download = async (item: NodeSummary) => {
    try {
      if (item.kind === "file") {
        window.location.assign(`/api/v1/nodes/${encodeURIComponent(item.id)}/content?download=1`);
        return;
      }
      const archive = await api.createZip(item.id);
      window.open(`/api/v1/zips/${encodeURIComponent(archive.id)}`, "_blank", "noopener");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.downloadError"));
    }
  };

  const startDrag = (item: NodeSummary) => {
    dragged.current = selected.has(item.id) ? [...selected] : [item.id];
  };

  const drop = async (destination: NodeSummary) => {
    const sources = dragged.current;
    dragged.current = [];
    if (sources.length === 0 || destination.kind !== "folder") return;
    try {
      for (const source of sources) {
        if (source !== destination.id) await api.move(source, destination.id);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("files.moveError"));
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] px-6 py-4 lg:px-8">
        <nav className="flex min-w-0 items-center gap-1 text-sm" aria-label="パンくずリスト">
          {path.map((part, index) => (
            <React.Fragment key={part.id}>
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-slate-600" />}
              <button
                className={`max-w-40 truncate rounded-lg px-2 py-1 text-[var(--fg-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] ${index === path.length - 1 ? "font-medium !text-[var(--fg)]" : ""}`}
                onClick={() => setCurrentId(part.id)}
              >
                {part.name}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            className="icon-button"
            onClick={() => void load()}
            aria-label={t("files.refresh")}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className="flex rounded-xl border border-white/10 bg-black/20 p-1">
            <button
              className={`view-button ${view === "grid" ? "view-button-active" : ""}`}
              onClick={() => switchView("grid")}
              aria-label={t("files.grid")}
            >
              <Grid2X2 className="h-4 w-4" />
            </button>
            <button
              className={`view-button ${view === "list" ? "view-button-active" : ""}`}
              onClick={() => switchView("list")}
              aria-label={t("files.list")}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <button className="primary-button" onClick={() => void createFolder()}>
            <Plus className="h-4 w-4" /> {t("files.newFolder")}
          </button>
        </div>
      </header>

      {error !== null && (
        <div className="mx-6 mt-4 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8"
        onClick={() => setSelected(new Set())}
      >
        {!loading && items.length === 0 ? (
          <div className="grid h-full min-h-72 place-items-center text-center">
            <div>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-sky-400/10">
                <Folder className="h-8 w-8 text-sky-400" strokeWidth={1.4} />
              </div>
              <h2 className="mt-5 text-lg font-medium text-[var(--fg)]">{t("files.emptyTitle")}</h2>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("files.emptyBody")}</p>
            </div>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
            {items.map((item) => (
              <article
                key={item.id}
                draggable
                onDragStart={() => startDrag(item)}
                onDragOver={(event) => item.kind === "folder" && event.preventDefault()}
                onDrop={() => void drop(item)}
                onClick={(event) => {
                  event.stopPropagation();
                  select(item, event);
                }}
                onDoubleClick={() => open(item)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ item, x: event.clientX, y: event.clientY });
                }}
                className={`group relative cursor-default rounded-2xl border p-4 transition duration-200 hover:-translate-y-0.5 hover:border-sky-400/30 hover:bg-white/[0.055] ${selected.has(item.id) ? "border-sky-400/50 bg-sky-400/10 shadow-[0_0_0_1px_rgba(56,189,248,.12)]" : "border-white/[0.08] bg-white/[0.025]"}`}
              >
                <div className="flex items-start justify-between">
                  <div className="grid h-12 w-12 place-items-center rounded-xl bg-black/20">
                    {iconFor(item)}
                  </div>
                  <button
                    className="rounded-lg p-1.5 text-slate-600 opacity-0 transition hover:bg-white/10 hover:text-[var(--fg)] group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenu({ item, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </div>
                <h3 className="mt-5 truncate text-sm font-medium text-[var(--fg)]">{item.name}</h3>
                <p className="mt-1 text-xs text-slate-600">
                  {item.kind === "folder" ? t("files.folder") : formatSize(item.size)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
            <div className="grid grid-cols-[1fr_120px_170px_36px] border-b border-white/[0.08] px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              <span>{t("files.name")}</span>
              <span>{t("files.size")}</span>
              <span>{t("files.modified")}</span>
              <span />
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={() => startDrag(item)}
                onDragOver={(event) => item.kind === "folder" && event.preventDefault()}
                onDrop={() => void drop(item)}
                onClick={(event) => {
                  event.stopPropagation();
                  select(item, event);
                }}
                onDoubleClick={() => open(item)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ item, x: event.clientX, y: event.clientY });
                }}
                className={`grid grid-cols-[1fr_120px_170px_36px] items-center border-b border-white/5 px-4 py-3 text-sm transition last:border-0 hover:bg-white/[0.04] ${selected.has(item.id) ? "bg-sky-400/10" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {iconFor(item)}
                  <span className="truncate text-[var(--fg)]">{item.name}</span>
                </span>
                <span className="text-xs text-slate-500">{formatSize(item.size)}</span>
                <span className="text-xs text-slate-500">
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
                <button className="text-slate-600 hover:text-[var(--fg)]">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected.size > 1 && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/10 bg-[var(--surface)] px-4 py-3 text-sm shadow-2xl backdrop-blur-xl">
          <span className="font-medium text-[var(--fg)]">
            {selected.size} {t("files.selected")}
          </span>
          <span className="h-5 w-px bg-white/10" />
          <button className="text-slate-400 transition hover:text-[var(--fg)]">
            {t("files.move")}
          </button>
          <button className="text-slate-400 transition hover:text-[var(--fg)]">
            {t("files.copy")}
          </button>
        </div>
      )}

      {menu !== null && (
        <div
          className="fixed z-50 w-52 overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] p-1.5 text-sm shadow-2xl backdrop-blur-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 220),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.item.kind === "file" && (
            <button
              className="context-item"
              onClick={() => {
                setDetailsItem(menu.item);
                setMenu(null);
              }}
            >
              <History className="h-4 w-4" /> {t("files.details")}
            </button>
          )}
          <button className="context-item" onClick={() => void rename(menu.item)}>
            <Pencil className="h-4 w-4" /> {t("files.rename")}
          </button>
          <button className="context-item" onClick={() => void copy(menu.item)}>
            <Copy className="h-4 w-4" /> {t("files.copy")}
          </button>
          <button className="context-item" onClick={() => void download(menu.item)}>
            <Download className="h-4 w-4" /> {t("files.download")}
          </button>
          <button
            className="context-item"
            onClick={() => {
              setShareItem(menu.item);
              setMenu(null);
            }}
          >
            <Share2 className="h-4 w-4" /> {t("files.share")}
          </button>
          <button className="context-item" onClick={() => setMenu(null)}>
            <FolderInput className="h-4 w-4" /> {t("files.moveDrag")}
          </button>
          <div className="my-1 h-px bg-white/[0.08]" />
          <button className="context-item text-rose-300" onClick={() => void trash(menu.item)}>
            <Trash2 className="h-4 w-4" /> {t("files.moveTrash")}
          </button>
        </div>
      )}
      {detailsItem !== null && (
        <FileDetails
          item={detailsItem}
          onClose={() => setDetailsItem(null)}
          onRestored={() => void load()}
        />
      )}
      {shareItem !== null && <ShareDialog item={shareItem} onClose={() => setShareItem(null)} />}
      {previewItem !== null && (
        <PreviewDialog item={previewItem} onClose={() => setPreviewItem(null)} />
      )}
    </section>
  );
}
