import type { LibraryItemSummary, LibraryRootSummary } from "@ncf/shared";
import { BookOpen, Library, RefreshCw, Tags, X } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";
import { ReaderView } from "./ReaderView";

interface LibraryViewProps {
  rootId: string;
}

export function LibraryView({ rootId }: LibraryViewProps): React.JSX.Element {
  const [items, setItems] = useState<LibraryItemSummary[]>([]);
  const [roots, setRoots] = useState<LibraryRootSummary[]>([]);
  const [selected, setSelected] = useState<LibraryItemSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [library, configured] = await Promise.all([api.libraryItems(), api.libraryRoots()]);
      setItems(library.items);
      setRoots(configured.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addRoot = async () => {
    setBusy(true);
    try {
      const response = await api.addLibraryRoot(rootId);
      setRoots(response.items);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.rootError"));
    } finally {
      setBusy(false);
    }
  };

  const removeRoot = async (nodeId: string) => {
    setBusy(true);
    try {
      await api.removeLibraryRoot(nodeId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.rootError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 sm:px-8">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <Library className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[.18em] text-[var(--accent)]">
            {t("library.eyebrow")}
          </p>
          <h2 className="text-xl font-semibold tracking-tight">{t("library.title")}</h2>
        </div>
        <button className="icon-button" onClick={() => void load()} aria-label={t("files.refresh")}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error !== null && (
        <div className="mx-5 mt-4 flex items-center justify-between rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-[var(--danger)]">
          {error}
          <button onClick={() => setError(null)} aria-label={t("library.dismissError")}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {roots.map((root) => (
            <span
              key={root.nodeId}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs"
            >
              {root.name || t("app.myDrive")}
              <button
                disabled={busy}
                onClick={() => void removeRoot(root.nodeId)}
                aria-label={t("library.removeRoot")}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!roots.some((root) => root.nodeId === rootId) && (
            <button className="primary-button" disabled={busy} onClick={() => void addRoot()}>
              <BookOpen className="h-4 w-4" /> {t("library.addRoot")}
            </button>
          )}
        </div>
        {!loading && items.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-3xl border border-dashed border-[var(--border)] text-center">
            <div className="max-w-md p-6">
              <BookOpen className="mx-auto h-10 w-10 text-[var(--accent)]" />
              <h3 className="mt-4 font-semibold">{t("library.emptyTitle")}</h3>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("library.emptyBody")}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
            {items.map((item) => (
              <button
                key={item.id}
                className="group overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-left shadow-sm transition hover:-translate-y-1 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-70"
                disabled={item.status !== "indexed"}
                onClick={() => setSelected(item)}
              >
                <div className="relative aspect-[2/3] overflow-hidden bg-[var(--surface-muted)]">
                  {item.coverUrl === null ? (
                    <BookOpen className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 text-[var(--fg-muted)]" />
                  ) : (
                    <img
                      alt=""
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      loading="lazy"
                      src={item.coverUrl}
                    />
                  )}
                  {item.readingState !== null && (
                    <span className="absolute bottom-2 left-2 rounded-full bg-[var(--overlay)] px-2 py-1 text-[10px] font-medium text-[var(--overlay-fg)]">
                      {t("library.continue")}
                    </span>
                  )}
                  {item.status !== "indexed" && (
                    <span className="absolute inset-x-2 bottom-2 rounded-lg bg-[var(--overlay)] px-2 py-1 text-center text-[10px] text-[var(--overlay-fg)]">
                      {item.status === "failed"
                        ? `${t("library.failed")}: ${item.errorCode ?? "unknown"}`
                        : t("library.indexing")}
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <h3 className="truncate text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 truncate text-xs text-[var(--fg-muted)]">
                    {[item.author, item.series].filter(Boolean).join(" · ") ||
                      item.kind.toUpperCase()}
                  </p>
                  {item.tags.length > 0 && (
                    <p className="mt-2 flex items-center gap-1 truncate text-[10px] text-[var(--fg-muted)]">
                      <Tags className="h-3 w-3 shrink-0" /> {item.tags.join(" · ")}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected !== null && <ReaderView item={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}
