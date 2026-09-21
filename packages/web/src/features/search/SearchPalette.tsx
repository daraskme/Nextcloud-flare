import type { NodeSummary } from "@ncf/shared";
import { File, Folder, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

interface SearchPaletteProps {
  rootId: string;
  onSelect: (item: NodeSummary) => void;
}

export function SearchPalette({ rootId, onSelect }: SearchPaletteProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NodeSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("ncf-search", show);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("ncf-search", show);
      window.removeEventListener("keydown", keyboard);
    };
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (query.trim() === "") {
      setResults([]);
      setTruncated(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setLoading(true);
      api
        .search(rootId, query, controller.signal)
        .then((response) => {
          setResults(response.items);
          setTruncated(response.truncated);
        })
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        })
        .finally(() => setLoading(false));
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, rootId]);

  if (!open) return <></>;
  return (
    <div
      className="fixed inset-0 z-[80] flex justify-center bg-[var(--overlay)] px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <section
        className="h-fit w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_30px_100px_rgba(0,0,0,.35)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-white/10 px-5">
          <Search
            className={`h-5 w-5 ${loading ? "animate-pulse text-sky-400" : "text-slate-500"}`}
          />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
            className="h-16 min-w-0 flex-1 bg-transparent text-base text-[var(--fg)] outline-none placeholder:text-slate-600"
          />
          <kbd className="rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-600">
            ESC
          </kbd>
          <button className="text-slate-600 hover:text-[var(--fg)]" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[55vh] overflow-auto p-2">
          {query.trim() === "" ? (
            <div className="px-4 py-10 text-center text-sm text-slate-600">{t("search.hint")}</div>
          ) : results.length === 0 && !loading ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--fg-muted)]">
              {t("search.none")}
            </div>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white/[0.06]"
                onClick={() => {
                  onSelect(item);
                  setOpen(false);
                }}
              >
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-white/[0.04]">
                  {item.kind === "folder" ? (
                    <Folder className="h-5 w-5 text-sky-400" />
                  ) : (
                    <File className="h-5 w-5 text-slate-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--fg)]">{item.name}</p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {item.kind === "folder" ? t("files.folder") : (item.mime ?? t("files.file"))}
                  </p>
                </div>
                <span className="text-xs text-[var(--fg-muted)]">{t("search.open")}</span>
              </button>
            ))
          )}
          {truncated && (
            <p className="px-4 py-2 text-center text-xs text-amber-400/70">
              {t("search.truncated")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
