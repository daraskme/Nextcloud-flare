import type { TrashItem } from "@ncf/shared";
import { File, Folder, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

function size(bytes: number | null): string {
  if (bytes === null) return t("files.folder");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function TrashView({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await api.trash()).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("trash.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const restore = async (item: TrashItem) => {
    setBusy(item.opId);
    try {
      await api.restoreTrash(item.opId);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("trash.restoreError"));
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item: TrashItem) => {
    if (!window.confirm(`${t("trash.confirm")}\n${item.name} (${item.memberCount})`)) return;
    setBusy(item.opId);
    try {
      await api.purgeTrash(item.opId);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("trash.deleteError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-5 lg:px-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-[var(--fg)]">
            {t("trash.title")}
          </h2>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">{t("trash.retention")}</p>
        </div>
        <button className="icon-button" onClick={() => void load()} aria-label={t("files.refresh")}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error !== null && (
        <div className="mx-6 mt-4 flex items-center justify-between rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {error}
          <button onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8">
        {!loading && items.length === 0 ? (
          <div className="grid h-full min-h-72 place-items-center text-center">
            <div>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-400/10">
                <Trash2 className="h-8 w-8 text-emerald-400" />
              </div>
              <h3 className="mt-5 text-lg font-medium text-[var(--fg)]">{t("trash.emptyTitle")}</h3>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("trash.emptyBody")}</p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
            {items.map((item) => (
              <article
                key={item.opId}
                className="flex items-center gap-4 border-b border-white/[0.06] px-4 py-3.5 last:border-0 hover:bg-white/[0.035]"
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04]">
                  {item.kind === "folder" ? (
                    <Folder className="h-5 w-5 text-sky-400" />
                  ) : (
                    <File className="h-5 w-5 text-slate-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--fg)]">{item.name}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    {size(item.size)} · {item.memberCount} {t("trash.items")} · {t("trash.deleted")}{" "}
                    {new Date(item.deletedAt).toLocaleDateString("ja-JP")}
                  </p>
                </div>
                <button
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 transition hover:bg-white/[0.06] hover:text-[var(--fg)] disabled:opacity-40"
                  disabled={busy === item.opId}
                  onClick={() => void restore(item)}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> {t("trash.restore")}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-rose-400 transition hover:bg-rose-400/10 disabled:opacity-40"
                  disabled={busy === item.opId}
                  onClick={() => void purge(item)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> {t("trash.deleteForever")}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
