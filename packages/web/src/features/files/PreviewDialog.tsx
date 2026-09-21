import type { NodeSummary } from "@ncf/shared";
import { Download, ExternalLink, X } from "lucide-react";
import React, { useEffect, useState } from "react";

import { t } from "../../i18n";

type PreviewKind = "image" | "pdf" | "text" | "audio" | "video" | "none";

const TEXT_EXTENSIONS =
  /\.(?:txt|md|markdown|csv|tsv|json|log|yaml|yml|toml|ini|xml|html?|css|js|ts|tsx|jsx|py|rs|go|java|c|h|cpp|sh|ps1|bat|sql)$/iu;
const TEXT_LIMIT = 512 * 1024;

export function previewKindFor(item: NodeSummary): PreviewKind {
  const mime = item.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  if (
    (mime === "" || mime === "application/octet-stream") &&
    TEXT_EXTENSIONS.test(item.name) &&
    (item.size ?? 0) <= TEXT_LIMIT
  ) {
    return "text";
  }
  return "none";
}

export function contentUrl(item: NodeSummary): string {
  return `/api/v1/nodes/${encodeURIComponent(item.id)}/content`;
}

interface PreviewDialogProps {
  item: NodeSummary;
  onClose: () => void;
}

function TextPreview({ item }: { item: NodeSummary }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(contentUrl(item), {
      headers: (item.size ?? 0) > TEXT_LIMIT ? { Range: `bytes=0-${TEXT_LIMIT - 1}` } : {},
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setError(t("preview.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);
  if (error !== null) return <p className="p-6 text-sm text-rose-400">{error}</p>;
  if (text === null) return <p className="p-6 text-sm text-slate-400">{t("preview.loading")}</p>;
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-sm leading-relaxed text-[var(--fg)]">
      {text}
      {(item.size ?? 0) > TEXT_LIMIT ? `\n\n… ${t("preview.truncated")}` : null}
    </pre>
  );
}

export function PreviewDialog({ item, onClose }: PreviewDialogProps): React.JSX.Element {
  const kind = previewKindFor(item);
  const url = contentUrl(item);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  let body: React.JSX.Element;
  switch (kind) {
    case "image":
      body = (
        <img
          src={url}
          alt={item.name}
          className="mx-auto max-h-[75vh] w-auto max-w-full object-contain"
        />
      );
      break;
    case "pdf":
      body = <iframe title={item.name} src={url} className="h-[75vh] w-full bg-white" />;
      break;
    case "text":
      body = <TextPreview item={item} />;
      break;
    case "audio":
      body = (
        <div className="p-8">
          <audio controls autoPlay src={url} className="w-full" />
        </div>
      );
      break;
    case "video":
      body = <video controls autoPlay src={url} className="mx-auto max-h-[75vh] max-w-full" />;
      break;
    default:
      body = (
        <div className="space-y-3 p-10 text-center">
          <p className="text-sm text-slate-400">{t("preview.unsupported")}</p>
          <a
            className="primary-button inline-flex items-center gap-2"
            href={url}
            download={item.name}
          >
            <Download className="h-4 w-4" />
            {t("files.download")}
          </a>
        </div>
      );
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-[var(--overlay)] p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        className="w-full max-w-5xl overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/30"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
      >
        <header className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-6 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[.2em] text-[var(--accent)]">
              {t("preview.title")}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-[var(--fg)]">{item.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <a
              className="icon-button"
              href={url}
              target="_blank"
              rel="noopener"
              aria-label={t("preview.openTab")}
              title={t("preview.openTab")}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <a
              className="icon-button"
              href={url}
              download={item.name}
              aria-label={t("files.download")}
              title={t("files.download")}
            >
              <Download className="h-4 w-4" />
            </a>
            <button className="icon-button" onClick={onClose} aria-label={t("preview.close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="bg-[var(--surface-muted)]">{body}</div>
      </section>
    </div>
  );
}
