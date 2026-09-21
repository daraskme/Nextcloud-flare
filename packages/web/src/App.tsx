import {
  BookOpen,
  Cloud,
  Files,
  HardDrive,
  Headphones,
  Image as ImageIcon,
  Link2,
  Moon,
  Search,
  Settings,
  Share2,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { NodeSummary } from "@ncf/shared";

import { AudioView } from "./features/audio/AudioView";
import { FileBrowser } from "./features/files/FileBrowser";
import { GalleryView } from "./features/gallery/GalleryView";
import { LibraryView } from "./features/library/LibraryView";
import { SearchPalette } from "./features/search/SearchPalette";
import { AppPasswords } from "./features/settings/AppPasswords";
import { SharesView } from "./features/shares/SharesView";
import { TrashView } from "./features/trash/TrashView";
import { UploadManager } from "./features/uploads/UploadManager";
import { t } from "./i18n";
import { api } from "./lib/api";
import { MiniPlayer } from "./player/MiniPlayer";

interface Workspace {
  rootId: string;
  email: string;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("ncf-theme") !== "light");
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [section, setSection] = useState<
    "files" | "trash" | "shares" | "shared" | "gallery" | "library" | "audio" | "settings"
  >("files");
  const [navigateTo, setNavigateTo] = useState<string>();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);

  useEffect(() => {
    const theme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ncf-theme", theme);
  }, [dark]);

  useEffect(() => {
    api
      .me()
      .then((response) =>
        setWorkspace({ rootId: response.workspace.rootId, email: response.user.email }),
      )
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("app.opening")),
      );
  }, []);

  useEffect(() => {
    if (workspace !== null)
      void api
        .stats()
        .then(setStats)
        .catch(() => setStats(null));
  }, [workspace, refreshKey]);

  const selectSearchResult = (item: NodeSummary) => {
    if (item.kind === "folder") {
      setSection("files");
      setNavigateTo(item.id);
    } else {
      window.open(`/api/v1/nodes/${encodeURIComponent(item.id)}/content`, "_blank", "noopener");
    }
  };

  const storageUsed = stats === null ? 0 : stats.usedBytes + stats.reservedBytes;
  const storagePercent =
    stats === null || stats.quotaBytes === 0
      ? 0
      : Math.min(100, (storageUsed / stats.quotaBytes) * 100);

  return (
    <main className="flex min-h-screen bg-[var(--bg)] text-[var(--fg)] transition-colors duration-300">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] p-4 backdrop-blur-xl lg:flex">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/20">
            <Cloud className="h-5 w-5 text-[var(--accent-fg)]" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Next Cloud</h1>
            <p className="text-[10px] uppercase tracking-[.22em] text-[var(--fg-muted)]">
              Cloudflare
            </p>
          </div>
        </div>
        <button
          className="primary-button mt-7 w-full justify-center"
          onClick={() => window.dispatchEvent(new Event("ncf-upload"))}
        >
          <Upload className="h-4 w-4" /> {t("app.upload")}
        </button>
        <nav className="mt-7 space-y-1">
          <button
            className={`nav-item ${section === "files" ? "nav-item-active" : ""}`}
            onClick={() => setSection("files")}
          >
            <Files className="h-4 w-4" /> {t("app.myDrive")}
          </button>
          <button
            className={`nav-item ${section === "shares" ? "nav-item-active" : ""}`}
            onClick={() => setSection("shares")}
          >
            <Link2 className="h-4 w-4" /> {t("app.sharing")}
          </button>
          <button
            className={`nav-item ${section === "shared" ? "nav-item-active" : ""}`}
            onClick={() => setSection("shared")}
          >
            <Share2 className="h-4 w-4" /> {t("app.sharedWithMe")}
          </button>
          <button
            className={`nav-item ${section === "gallery" ? "nav-item-active" : ""}`}
            onClick={() => setSection("gallery")}
          >
            <ImageIcon className="h-4 w-4" /> {t("app.gallery")}
          </button>
          <button
            className={`nav-item ${section === "library" ? "nav-item-active" : ""}`}
            onClick={() => setSection("library")}
          >
            <BookOpen className="h-4 w-4" /> {t("app.bookshelf")}
          </button>
          <button
            className={`nav-item ${section === "audio" ? "nav-item-active" : ""}`}
            onClick={() => setSection("audio")}
          >
            <Headphones className="h-4 w-4" /> {t("app.audio")}
          </button>
          <button
            className="nav-item"
            onClick={() => window.dispatchEvent(new Event("ncf-search"))}
          >
            <Search className="h-4 w-4" /> {t("app.search")} <kbd>⌘K</kbd>
          </button>
          <button
            className={`nav-item ${section === "trash" ? "nav-item-active" : ""}`}
            onClick={() => setSection("trash")}
          >
            <Trash2 className="h-4 w-4" /> {t("app.trash")}
          </button>
        </nav>
        <div className="mt-auto space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-[var(--fg-muted)]">
                <HardDrive className="h-3.5 w-3.5" /> {t("app.storage")}
              </span>
              <span className="text-right tabular-nums">
                {stats === null
                  ? "—"
                  : `${formatBytes(storageUsed)} / ${formatBytes(stats.quotaBytes)}`}
              </span>
            </div>
            <div
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-hover)]"
              role="progressbar"
              aria-label={t("app.storage")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(storagePercent)}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-500"
                style={{ width: `${storagePercent}%` }}
              />
            </div>
          </div>
          <button className="nav-item" onClick={() => setDark((value) => !value)}>
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}{" "}
            {dark ? t("app.lightMode") : t("app.darkMode")}
          </button>
          <button
            className={`nav-item border-t border-[var(--border)] pt-4 ${section === "settings" ? "nav-item-active" : ""}`}
            onClick={() => setSection("settings")}
          >
            <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-600 text-xs font-bold text-[var(--accent-fg)]">
              {workspace?.email.slice(0, 1).toUpperCase() ?? "N"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {workspace?.email ?? t("app.connecting")}
              </p>
              <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                {t("app.privateWorkspace")}
              </p>
            </div>
            <Settings className="h-4 w-4 text-[var(--fg-muted)]" />
          </button>
        </div>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {workspace !== null ? (
          section === "files" ? (
            <FileBrowser
              rootId={workspace.rootId}
              refreshKey={refreshKey}
              onNavigate={setCurrentFolder}
              navigateTo={navigateTo}
            />
          ) : section === "trash" ? (
            <TrashView onChanged={() => setRefreshKey((value) => value + 1)} />
          ) : section === "gallery" ? (
            <GalleryView rootId={workspace.rootId} />
          ) : section === "library" ? (
            <LibraryView rootId={workspace.rootId} />
          ) : section === "audio" ? (
            <AudioView rootId={workspace.rootId} />
          ) : section === "settings" ? (
            <AppPasswords />
          ) : (
            <SharesView
              mode={section === "shares" ? "owned" : "shared"}
              onOpen={(nodeId, kind) => {
                if (kind === "file") {
                  window.open(
                    `/api/v1/nodes/${encodeURIComponent(nodeId)}/content`,
                    "_blank",
                    "noopener",
                  );
                } else {
                  setNavigateTo(nodeId);
                  setSection("files");
                }
              }}
            />
          )
        ) : (
          <div className="grid min-h-screen place-items-center">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-sky-400/20 border-t-sky-400" />
              <p className="mt-4 text-sm text-[var(--fg-muted)]">{error ?? t("app.opening")}</p>
            </div>
          </div>
        )}
      </div>
      {workspace !== null && (
        <SearchPalette rootId={workspace.rootId} onSelect={selectSearchResult} />
      )}
      {workspace !== null && section === "files" && (
        <UploadManager
          parentId={currentFolder ?? workspace.rootId}
          onCompleted={() => setRefreshKey((value) => value + 1)}
        />
      )}
      {workspace !== null && <MiniPlayer />}
    </main>
  );
}
