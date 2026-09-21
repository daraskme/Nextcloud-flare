import type { BreadcrumbItem, NodeSummary } from "@ncf/shared";
import {
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderInput,
  Grid2X2,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";

type ViewMode = "grid" | "list";

interface FileBrowserProps {
  rootId: string;
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

export function FileBrowser({ rootId }: FileBrowserProps): React.JSX.Element {
  const [currentId, setCurrentId] = useState(rootId);
  const [items, setItems] = useState<NodeSummary[]>([]);
  const [path, setPath] = useState<BreadcrumbItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewMode>(() =>
    localStorage.getItem("ncf-view") === "list" ? "list" : "grid",
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

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
      setError(cause instanceof Error ? cause.message : "Could not load this folder");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [currentId]);

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
    else window.open(`/api/v1/nodes/${encodeURIComponent(item.id)}/content`, "_blank", "noopener");
  };

  const createFolder = async () => {
    const name = window.prompt("Folder name");
    if (name === null || name.trim() === "") return;
    try {
      await api.createFolder(currentId, name.trim());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create folder");
    }
  };

  const rename = async (item: NodeSummary) => {
    const name = window.prompt("Rename item", item.name);
    if (name === null || name.trim() === "" || name === item.name) return;
    try {
      await api.rename(item.id, name.trim());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename item");
    }
  };

  const copy = async (item: NodeSummary) => {
    try {
      await api.copy(item.id, currentId, `${item.name} copy`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy item");
    }
  };

  const drop = async (destination: NodeSummary) => {
    const source = dragged.current;
    dragged.current = null;
    if (source === null || source === destination.id || destination.kind !== "folder") return;
    try {
      await api.move(source, destination.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not move item");
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] px-6 py-4 lg:px-8">
        <nav className="flex min-w-0 items-center gap-1 text-sm" aria-label="Breadcrumb">
          {path.map((part, index) => (
            <React.Fragment key={part.id}>
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-slate-600" />}
              <button
                className={`max-w-40 truncate rounded-lg px-2 py-1 transition hover:bg-white/5 hover:text-white ${index === path.length - 1 ? "font-medium text-white" : "text-slate-400"}`}
                onClick={() => setCurrentId(part.id)}
              >
                {part.name}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button className="icon-button" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className="flex rounded-xl border border-white/10 bg-black/20 p-1">
            <button
              className={`view-button ${view === "grid" ? "view-button-active" : ""}`}
              onClick={() => switchView("grid")}
              aria-label="Grid view"
            >
              <Grid2X2 className="h-4 w-4" />
            </button>
            <button
              className={`view-button ${view === "list" ? "view-button-active" : ""}`}
              onClick={() => switchView("list")}
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <button className="primary-button" onClick={() => void createFolder()}>
            <Plus className="h-4 w-4" /> New folder
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
              <h2 className="mt-5 text-lg font-medium text-white">This folder is empty</h2>
              <p className="mt-2 text-sm text-slate-500">
                Create a folder or drop files here to begin.
              </p>
            </div>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
            {items.map((item) => (
              <article
                key={item.id}
                draggable
                onDragStart={() => (dragged.current = item.id)}
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
                    className="rounded-lg p-1.5 text-slate-600 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenu({ item, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </div>
                <h3 className="mt-5 truncate text-sm font-medium text-slate-200">{item.name}</h3>
                <p className="mt-1 text-xs text-slate-600">
                  {item.kind === "folder" ? "Folder" : formatSize(item.size)}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
            <div className="grid grid-cols-[1fr_120px_170px_36px] border-b border-white/[0.08] px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              <span>Name</span>
              <span>Size</span>
              <span>Modified</span>
              <span />
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={() => (dragged.current = item.id)}
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
                  <span className="truncate text-slate-200">{item.name}</span>
                </span>
                <span className="text-xs text-slate-500">{formatSize(item.size)}</span>
                <span className="text-xs text-slate-500">
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
                <button className="text-slate-600 hover:text-white">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected.size > 1 && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/95 px-4 py-3 text-sm shadow-2xl backdrop-blur-xl">
          <span className="font-medium text-white">{selected.size} selected</span>
          <span className="h-5 w-px bg-white/10" />
          <button className="text-slate-400 transition hover:text-white">Move</button>
          <button className="text-slate-400 transition hover:text-white">Copy</button>
        </div>
      )}

      {menu !== null && (
        <div
          className="fixed z-50 w-52 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 p-1.5 text-sm shadow-2xl backdrop-blur-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 170),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button className="context-item" onClick={() => void rename(menu.item)}>
            <Pencil className="h-4 w-4" /> Rename
          </button>
          <button className="context-item" onClick={() => void copy(menu.item)}>
            <Copy className="h-4 w-4" /> Make a copy
          </button>
          <button className="context-item" onClick={() => setMenu(null)}>
            <FolderInput className="h-4 w-4" /> Move with drag & drop
          </button>
        </div>
      )}
    </section>
  );
}
