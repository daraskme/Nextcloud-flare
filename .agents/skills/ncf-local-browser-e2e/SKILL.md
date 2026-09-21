---
name: ncf-local-browser-e2e
description: Run Nextcloud-flare browser E2E with local Cloudflare resources and distinguish development bypass from anonymous authentication.
---

# Local browser E2E

Use the requested worktree, not another agent's checkout. Node 20 and pnpm 9 are required.

1. Run `pnpm install`, then `pnpm --filter @ncf/shared build` and `pnpm --filter @ncf/web build`.
2. Copy `.dev.vars.example` to ignored `.dev.vars`; configure a disposable development principal and matching OWNER_EMAILS plus local-only signing keys. Never use production secrets for local fixtures.
3. Run `pnpm dev`; verify migration completion and readiness of Vite on 5173 and Wrangler on 8787. Start only your own processes; never kill unrelated node/workerd processes.
4. Files larger than 8 MiB use multipart uploads. A deterministic 15 MiB fixture should generate two uploaded parts. Compare browser downloads by SHA-256 and inspect folder ZIP entries, not just UI completion.
5. Use the date picker's calendar for share expiration and verify the saved owner card, rather than assuming keystrokes populated the date.
6. Incognito on loopback still gets the configured dev principal. It is not an anonymous-auth test. For missing-credential denial, start an isolated Worker with `pnpm exec wrangler dev --local --port 8790 --inspector-port 9231 --env-file <absolute-empty-env-file> --persist-to <absolute-disposable-state-directory>`. In Wrangler 4.71 explicit --env-file skips .dev.vars. Confirm no DEV_PRINCIPAL_EMAIL binding in startup output; unauthenticated GET /api/v1/me should return 401 with no user data. This does not verify deployed Access JWT handling.
7. Generated /s/* URLs must reach the public-share entry point, not the private Vite SPA fallback. If public routing fails locally, report password enforcement, public isolation and expired/disabled denial as blocked rather than passing them via the private dev principal.
8. Inspect runtime compatibility warnings: the installed workerd may fall back to an older compatibility date than wrangler.jsonc requests. Record this limitation.

## Devin Secrets Needed

None for isolated local testing with a disposable dev principal. Real Cloudflare Access or multi-user deployed testing needs a separately approved environment and appropriate credentials.
