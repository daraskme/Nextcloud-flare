import { Check, Copy, KeyRound, Plus, ShieldOff, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppPasswordSummary, CreatedAppPassword } from "@ncf/shared";

import { api } from "../../lib/api";

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(value);
}

export function AppPasswords(): React.JSX.Element {
  const [items, setItems] = useState<AppPasswordSummary[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<CreatedAppPassword | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .appPasswords()
      .then((response) => setItems(response.items))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load app passwords"),
      );

  useEffect(() => {
    void load();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (label.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createAppPassword(label.trim(), days);
      setCreated(result);
      setLabel("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create app password");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeAppPassword(id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke app password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-h-screen overflow-y-auto px-5 py-8 sm:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-violet-500/10 text-violet-500">
            <KeyRound className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[.18em] text-violet-500">
              Security
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">App passwords</h2>
            <p className="mt-1 text-sm text-slate-500">
              Use WebDAV without exposing your account session.
            </p>
          </div>
        </div>

        <form
          className="mt-8 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.025] sm:grid-cols-[1fr_10rem_auto]"
          onSubmit={(event) => void create(event)}
        >
          <label className="text-xs font-medium text-slate-500">
            Label
            <input
              className="mt-2 w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-sky-400 dark:border-white/10"
              maxLength={64}
              placeholder="Laptop WebDAV"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium text-slate-500">
            Expires
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2.5 text-sm outline-none dark:border-white/10"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <button
            className="primary-button self-end"
            disabled={busy || label.trim() === ""}
            type="submit"
          >
            <Plus className="h-4 w-4" /> Create
          </button>
        </form>

        {error !== null && (
          <p className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-500">{error}</p>
        )}

        <div className="mt-6 space-y-3">
          {items.map((item) => {
            const inactive = item.revokedAt !== null || item.expiresAt <= Date.now();
            return (
              <article
                className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/[0.08] dark:bg-white/[0.025] sm:flex-row sm:items-center"
                key={item.id}
              >
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/5">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium">{item.label}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${inactive ? "bg-slate-500/10 text-slate-500" : "bg-emerald-500/10 text-emerald-500"}`}
                    >
                      {inactive ? "Inactive" : "Active"}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-slate-500">{item.id}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Expires {formatDate(item.expiresAt)}
                    {item.lastUsedAt === null
                      ? " · Never used"
                      : ` · Last used ${formatDate(item.lastUsedAt)}`}
                  </p>
                </div>
                {!inactive && (
                  <button
                    className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 px-3 py-2 text-xs font-medium text-red-500 transition hover:bg-red-500/10"
                    disabled={busy}
                    onClick={() => void revoke(item.id)}
                  >
                    <ShieldOff className="h-3.5 w-3.5" /> Revoke
                  </button>
                )}
              </article>
            );
          })}
          {items.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 dark:border-white/10">
              No app passwords yet.
            </div>
          )}
        </div>
      </div>

      {created !== null && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#101620] p-6 text-slate-100 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-[.18em] text-emerald-400">
                  Created
                </p>
                <h3 className="mt-2 text-xl font-semibold">Save this password now</h3>
                <p className="mt-2 text-sm text-slate-400">
                  It will never be shown again. Use the ID as your Basic username.
                </p>
              </div>
              <button className="icon-button" onClick={() => setCreated(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 space-y-3 rounded-2xl bg-black/30 p-4 font-mono text-xs">
              <div>
                <span className="text-slate-500">Username</span>
                <p className="mt-1 break-all">{created.id}</p>
              </div>
              <div>
                <span className="text-slate-500">Password</span>
                <p className="mt-1 break-all text-sky-300">{created.secret}</p>
              </div>
            </div>
            <button
              className="primary-button mt-5 w-full justify-center"
              onClick={() => {
                void navigator.clipboard.writeText(`${created.id}:${created.secret}`);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy credentials"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
