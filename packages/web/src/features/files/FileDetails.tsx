import type { NodeSummary, NodeVersionSummary } from "@ncf/shared";
import { History, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

interface FileDetailsProps {
  item: NodeSummary;
  onClose: () => void;
  onRestored: () => void;
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function FileDetails({ item, onClose, onRestored }: FileDetailsProps): React.JSX.Element {
  const [node, setNode] = useState(item);
  const [versions, setVersions] = useState<NodeVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setVersions((await api.versions(node.id)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("details.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNode(item);
  }, [item]);

  useEffect(() => {
    void load();
  }, [node.id, node.revision]);

  const restore = async (version: NodeVersionSummary) => {
    if (version.id === null || !window.confirm(t("details.confirm"))) return;
    setRestoring(version.id);
    setError(null);
    try {
      const restored = await api.restoreVersion(node.id, version.id, node.revision);
      setNode(restored);
      onRestored();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("details.restoreError"));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-30 w-[min(420px,100%)] overflow-auto border-l border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl backdrop-blur-xl">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--accent)]">{t("details.title")}</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-[var(--fg)]">{node.name}</h2>
        </div>
        <button className="icon-button shrink-0" onClick={onClose} aria-label="詳細を閉じる">
          <X className="h-4 w-4" />
        </button>
      </header>
      <dl className="mt-6 grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-sm">
        <dt className="text-[var(--fg-muted)]">{t("details.size")}</dt>
        <dd className="text-right text-[var(--fg)]">{formatSize(node.size ?? 0)}</dd>
        <dt className="text-[var(--fg-muted)]">{t("details.updated")}</dt>
        <dd className="text-right text-[var(--fg)]">
          {new Date(node.updatedAt).toLocaleString("ja-JP")}
        </dd>
      </dl>
      <div className="mt-7 flex items-center gap-2">
        <History className="h-4 w-4 text-sky-400" />
        <h3 className="font-medium text-[var(--fg)]">{t("details.versions")}</h3>
      </div>
      {error !== null && (
        <p className="mt-3 rounded-xl bg-rose-400/10 px-3 py-2 text-sm text-rose-300">{error}</p>
      )}
      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="py-6 text-center text-sm text-[var(--fg-muted)]">{t("details.loading")}</p>
        ) : (
          versions.map((version) => (
            <article
              key={version.id ?? "current"}
              className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--fg)]">
                  {version.current
                    ? t("details.current")
                    : new Date(version.createdAt).toLocaleString("ja-JP")}
                </p>
                <p className="mt-1 text-xs text-[var(--fg-muted)]">{formatSize(version.size)}</p>
              </div>
              {!version.current && (
                <button
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-white/5 hover:text-[var(--fg)] disabled:opacity-50"
                  disabled={restoring !== null}
                  onClick={() => void restore(version)}
                >
                  <RotateCcw
                    className={`h-3.5 w-3.5 ${restoring === version.id ? "animate-spin" : ""}`}
                  />
                  {t("details.restore")}
                </button>
              )}
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
