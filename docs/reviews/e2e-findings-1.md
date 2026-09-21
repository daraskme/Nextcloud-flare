# Local E2E findings (ee2c48f) — must fix in next implementation pass

Source: browser-driven E2E in worktree, see PR #1 comment.

## Defects (fix)

1. **Japanese filenames rejected** (`Name is outside the Foundation-safe subset`). v1 must accept Unicode names per DESIGN name normalization (NFC, forbid control chars / `/` / `\` / leading-trailing space+dot / reserved Windows names, length ≤ 255 bytes UTF-8 by portable rule). Remove the ASCII-only "Foundation-safe subset" gate from the upload/create path (keep any *portable-name uniqueness* rule). Add tests with `旅行メモ.txt`, `同人誌 vol.1.cbz`, emoji.
2. **Same-name upload → 409 at 92%** instead of overwrite/version flow. Web UI must offer "上書き（新しいバージョン）/ 両方残す（名前変更）/ スキップ" on conflict; API `complete` with `mode=overwrite&expectedRevision=` creates a new version (Phase 2 versioning exists). Add version list UI (right panel / details) with restore-to-version.
3. **Delete forever (Trash purge) → 409 `mutation_rejected`** after restore→re-trash of the same node. Root-cause the permit/revision/trash_members precondition that fails on a second trash cycle; add regression test `trash-retrash-purge.test.ts`.
4. **Light theme contrast**: filenames and breadcrumb near-white on light background. Audit Tailwind tokens: use semantic CSS variables (`--fg`, `--fg-muted`, `--bg`, `--surface`) switched by `[data-theme]`, not hard-coded `text-white`. Check every view in light mode.
5. **Local public share routing**: `/s/<id>#secret` on :5173 falls through Vite SPA fallback into the private app; on the Worker :8787 it redirects to `/public-share` then 404. Required: (a) in dev, Vite must proxy `/s/*`, `/api/*`, `/dav/*` to the Worker (or serve UI via `wrangler dev` assets); (b) Worker `/s/*` must serve the public share shell (separate entry `public.html` / route in SPA that never mounts private app and never uses the dev principal); (c) dev principal must NOT apply to public routes (`/s/*`, `/api/v1/public/*`) — public routes are anonymous by design. Add an integration test: anonymous GET `/s/<id>` → 200 public shell, anonymous GET `/api/v1/public/shares/<id>` without secret → 401/403, with secret → share metadata only.
6. Path traversal name (`..`, `../escape`) is rejected but error text says "An item with this name already exists" — return `invalid_name` with a clear message.
7. Storage usage shows `0.0 GB` for ~15 MiB — format adaptively (B/KB/MB/GB) and show `used / quota` with a bar.
8. Disabled share has no explicit status badge; mixed English/Japanese labels — pick Japanese primary UI copy with i18n dictionary (`ja` default, `en` fallback) rather than mixing.
9. `wrangler.jsonc` `compatibility_date` 2026-09-21 falls back to installed runtime 2026-03-01 — set a compatibility_date supported by the pinned `wrangler`/`workerd` versions.

## Not yet verified (add automated coverage where possible)
- interrupted-upload resume, preview, starred/tags, second-user shared-with-me, narrow viewport, public share password/expiry/disable enforcement, public ZIP/download, view/upload-only permissions.
