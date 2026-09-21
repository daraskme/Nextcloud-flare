import type { NodeSummary, ShareKind, ShareMode, ShareSummary } from "@ncf/shared";
import { Check, Copy, Link2, LockKeyhole, UserRound, X } from "lucide-react";
import { useState } from "react";

import { api } from "../../lib/api";

interface ShareDialogProps {
  item: NodeSummary;
  onClose: () => void;
}

export function ShareDialog({ item, onClose }: ShareDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<ShareKind>("link");
  const [mode, setMode] = useState<ShareMode>("view");
  const [password, setPassword] = useState("");
  const [granteeEmail, setGranteeEmail] = useState("");
  const [expires, setExpires] = useState("");
  const [created, setCreated] = useState<ShareSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(
        await api.createShare({
          rootNodeId: item.id,
          kind,
          mode,
          expiresAt: expires === "" ? null : new Date(`${expires}T23:59:59`).getTime(),
          ...(kind === "link" && password !== "" ? { password } : {}),
          ...(kind === "user" ? { granteeEmail } : {}),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create share");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (created?.publicUrl === undefined) return;
    await navigator.clipboard.writeText(created.publicUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <section className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/40">
        <header className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-[.2em] text-sky-400">Share</p>
            <h2 className="mt-1 max-w-sm truncate text-lg font-semibold text-white">{item.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close share dialog">
            <X className="h-4 w-4" />
          </button>
        </header>

        {created !== null ? (
          <div className="space-y-5 p-6">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-400">
              <Check className="h-7 w-7" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-white">Share is ready</h3>
              <p className="mt-1 text-sm text-slate-400">
                {created.kind === "link"
                  ? "The secret is only shown in this link. Copy it now."
                  : `Shared with ${created.granteeEmail ?? "the recipient"}.`}
              </p>
            </div>
            {created.publicUrl !== undefined && (
              <div className="flex gap-2 rounded-2xl border border-white/10 bg-black/20 p-2">
                <input
                  readOnly
                  value={created.publicUrl}
                  className="min-w-0 flex-1 bg-transparent px-3 text-xs text-slate-300 outline-none"
                />
                <button className="primary-button shrink-0" onClick={() => void copyLink()}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-5 p-6">
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-black/20 p-1.5">
              <button
                className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm transition ${kind === "link" ? "bg-white/10 text-white shadow" : "text-slate-500 hover:text-slate-300"}`}
                onClick={() => setKind("link")}
              >
                <Link2 className="h-4 w-4" /> Link share
              </button>
              <button
                className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm transition ${kind === "user" ? "bg-white/10 text-white shadow" : "text-slate-500 hover:text-slate-300"}`}
                onClick={() => {
                  setKind("user");
                  if (mode === "upload") setMode("view");
                }}
              >
                <UserRound className="h-4 w-4" /> Person
              </button>
            </div>

            {kind === "user" && (
              <label className="block text-xs font-medium text-slate-400">
                Recipient email
                <input
                  type="email"
                  value={granteeEmail}
                  onChange={(event) => setGranteeEmail(event.target.value)}
                  placeholder="person@example.com"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/50"
                />
              </label>
            )}

            <fieldset>
              <legend className="text-xs font-medium text-slate-400">Permission</legend>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(["view", "download", ...(kind === "link" ? ["upload"] : [])] as ShareMode[]).map(
                  (value) => (
                    <button
                      key={value}
                      className={`rounded-xl border px-3 py-2.5 text-sm capitalize transition ${mode === value ? "border-sky-400/50 bg-sky-400/10 text-sky-300" : "border-white/10 text-slate-500 hover:border-white/20 hover:text-slate-300"}`}
                      onClick={() => setMode(value)}
                    >
                      {value === "upload" ? "Upload only" : value}
                    </button>
                  ),
                )}
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-400">
                Expiration
                <input
                  type="date"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-sky-400/50"
                />
              </label>
              {kind === "link" && (
                <label className="text-xs font-medium text-slate-400">
                  Password
                  <span className="relative mt-2 block">
                    <LockKeyhole className="absolute left-3 top-3 h-4 w-4 text-slate-600" />
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-10 pr-3 text-sm text-white outline-none focus:border-sky-400/50"
                    />
                  </span>
                </label>
              )}
            </div>

            {error !== null && (
              <p className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            )}
            <button
              className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || (kind === "user" && granteeEmail.trim() === "")}
              onClick={() => void submit()}
            >
              {busy ? "Creating…" : "Create share"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
