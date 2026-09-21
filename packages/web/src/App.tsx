import { Cloud, Files, HardDrive, Moon, Search, Settings, Sun, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { FileBrowser } from "./features/files/FileBrowser";
import { TrashView } from "./features/trash/TrashView";
import { UploadManager } from "./features/uploads/UploadManager";
import { api } from "./lib/api";

interface Workspace {
  rootId: string;
  email: string;
}

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("ncf-theme") !== "light");
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [section, setSection] = useState<"files" | "trash">("files");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ncf-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    api
      .me()
      .then((response) =>
        setWorkspace({ rootId: response.workspace.rootId, email: response.user.email }),
      )
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not open workspace"),
      );
  }, []);

  return (
    <main className="flex min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-[#080b11] dark:text-slate-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white/70 p-4 backdrop-blur-xl dark:border-white/[0.08] dark:bg-[#0b0f17]/90 lg:flex">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/20">
            <Cloud className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Next Cloud</h1>
            <p className="text-[10px] uppercase tracking-[.22em] text-slate-500">Cloudflare</p>
          </div>
        </div>
        <button
          className="primary-button mt-7 w-full justify-center"
          onClick={() => window.dispatchEvent(new Event("ncf-upload"))}
        >
          <Upload className="h-4 w-4" /> Upload
        </button>
        <nav className="mt-7 space-y-1">
          <button
            className={`nav-item ${section === "files" ? "nav-item-active" : ""}`}
            onClick={() => setSection("files")}
          >
            <Files className="h-4 w-4" /> My Drive
          </button>
          <button className="nav-item">
            <Search className="h-4 w-4" /> Search <kbd>⌘K</kbd>
          </button>
          <button
            className={`nav-item ${section === "trash" ? "nav-item-active" : ""}`}
            onClick={() => setSection("trash")}
          >
            <Trash2 className="h-4 w-4" /> Trash
          </button>
        </nav>
        <div className="mt-auto space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-100/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.025]">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-500">
                <HardDrive className="h-3.5 w-3.5" /> Storage
              </span>
              <span>—</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
              <div className="h-full w-0 rounded-full bg-sky-400" />
            </div>
          </div>
          <button className="nav-item" onClick={() => setDark((value) => !value)}>
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}{" "}
            {dark ? "Light mode" : "Dark mode"}
          </button>
          <div className="flex items-center gap-3 border-t border-slate-200 px-2 pt-4 dark:border-white/[0.08]">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-600 text-xs font-bold text-white">
              {workspace?.email.slice(0, 1).toUpperCase() ?? "N"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{workspace?.email ?? "Connecting…"}</p>
              <p className="text-[10px] text-emerald-500">Private workspace</p>
            </div>
            <Settings className="h-4 w-4 text-slate-500" />
          </div>
        </div>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {workspace !== null ? (
          section === "files" ? (
            <FileBrowser
              rootId={workspace.rootId}
              refreshKey={refreshKey}
              onNavigate={setCurrentFolder}
            />
          ) : (
            <TrashView onChanged={() => setRefreshKey((value) => value + 1)} />
          )
        ) : (
          <div className="grid min-h-screen place-items-center">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-sky-400/20 border-t-sky-400" />
              <p className="mt-4 text-sm text-slate-500">
                {error ?? "Opening your private cloud…"}
              </p>
            </div>
          </div>
        )}
      </div>
      {workspace !== null && section === "files" && (
        <UploadManager
          parentId={currentFolder ?? workspace.rootId}
          onCompleted={() => setRefreshKey((value) => value + 1)}
        />
      )}
    </main>
  );
}
