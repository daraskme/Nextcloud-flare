import type { ShareSummary, SharedMount } from "@ncf/shared";
import { ExternalLink, File, Folder, Link2, RefreshCw, ShieldOff, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

interface SharesViewProps {
  mode: "owned" | "shared";
  onOpen: (nodeId: string, kind: "root" | "folder" | "file") => void;
}

function shareMode(mode: ShareSummary["mode"]): string {
  if (mode === "view") return t("share.view");
  if (mode === "download") return t("share.download");
  return t("share.uploadOnly");
}

export function SharesView({ mode, onOpen }: SharesViewProps): React.JSX.Element {
  const [owned, setOwned] = useState<ShareSummary[]>([]);
  const [shared, setShared] = useState<SharedMount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === "owned") setOwned((await api.shares()).items);
      else setShared((await api.sharedWithMe()).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("shares.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [mode]);

  const disable = async (shareId: string) => {
    try {
      await api.disableShare(shareId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("shares.disableError"));
    }
  };

  const items = mode === "owned" ? owned : shared;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-5 lg:px-8">
        <div>
          <p className="text-xs font-medium uppercase tracking-[.2em] text-[var(--accent)]">
            {mode === "owned" ? t("shares.ownedEyebrow") : t("shares.sharedEyebrow")}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-[var(--fg)]">
            {mode === "owned" ? t("app.sharing") : t("app.sharedWithMe")}
          </h2>
        </div>
        <button className="icon-button" onClick={() => void load()} aria-label={t("files.refresh")}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error !== null && (
        <div className="mx-6 mt-5 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-6 lg:p-8">
        {!loading && items.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-3xl border border-dashed border-white/10 text-center">
            <div>
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sky-400/10 text-sky-400">
                {mode === "owned" ? (
                  <Link2 className="h-6 w-6" />
                ) : (
                  <UserRound className="h-6 w-6" />
                )}
              </div>
              <h3 className="mt-4 font-medium text-[var(--fg)]">{t("shares.emptyTitle")}</h3>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                {mode === "owned" ? t("shares.emptyOwned") : t("shares.emptyShared")}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {mode === "owned"
              ? owned.map((share) => (
                  <article
                    key={share.id}
                    className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 transition hover:border-sky-400/25 hover:bg-white/[0.045]"
                  >
                    <div className="flex items-start justify-between">
                      <div className="grid h-11 w-11 place-items-center rounded-xl bg-sky-400/10 text-sky-400">
                        {share.root.kind === "file" ? (
                          <File className="h-5 w-5" />
                        ) : (
                          <Folder className="h-5 w-5" />
                        )}
                      </div>
                      <div className="flex flex-wrap justify-end gap-2">
                        <span className="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[10px] font-medium text-[var(--fg-muted)]">
                          {shareMode(share.mode)}
                        </span>
                        {share.disabledAt !== null && (
                          <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-[10px] font-semibold text-rose-700 dark:text-rose-300">
                            {t("shares.disabled")}
                          </span>
                        )}
                      </div>
                    </div>
                    <h3 className="mt-4 truncate font-medium text-[var(--fg)]">
                      {share.root.name || t("app.myDrive")}
                    </h3>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {share.kind === "link" ? t("shares.link") : share.granteeEmail}
                      {share.passwordProtected ? ` · ${t("shares.password")}` : ""}
                    </p>
                    <div className="mt-5 flex items-center justify-between border-t border-white/[0.07] pt-4">
                      <span className="text-[11px] text-slate-600">
                        {share.expiresAt === null
                          ? t("shares.noExpiration")
                          : `${t("shares.expires")} ${new Date(share.expiresAt).toLocaleDateString("ja-JP")}`}
                      </span>
                      {share.disabledAt === null && (
                        <button
                          className="flex items-center gap-1.5 text-xs text-rose-300 transition hover:text-rose-200"
                          onClick={() => void disable(share.id)}
                        >
                          <ShieldOff className="h-3.5 w-3.5" /> {t("shares.disable")}
                        </button>
                      )}
                    </div>
                  </article>
                ))
              : shared.map((mount) => (
                  <button
                    key={mount.shareId}
                    className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 text-left transition hover:-translate-y-0.5 hover:border-sky-400/30 hover:bg-white/[0.05]"
                    onClick={() => onOpen(mount.root.id, mount.root.kind)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-400/10 text-violet-300">
                        {mount.root.kind === "file" ? (
                          <File className="h-5 w-5" />
                        ) : (
                          <Folder className="h-5 w-5" />
                        )}
                      </div>
                      <ExternalLink className="h-4 w-4 text-slate-600 transition group-hover:text-sky-400" />
                    </div>
                    <h3 className="mt-4 truncate font-medium text-[var(--fg)]">
                      {mount.root.name}
                    </h3>
                    <p className="mt-1 truncate text-xs text-[var(--fg-muted)]">
                      {t("shares.from")} {mount.ownerEmail}
                    </p>
                    <p className="mt-4 text-[10px] uppercase tracking-wider text-slate-600">
                      {mount.mountName} · {shareMode(mount.mode)}
                    </p>
                  </button>
                ))}
          </div>
        )}
      </div>
    </section>
  );
}
