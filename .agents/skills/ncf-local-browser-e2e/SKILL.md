---
name: ncf-local-browser-e2e
description: Run the repository's isolated HTTPS Playwright suite for private, public-share, content-origin, upload, and WebDAV behavior.
---

# Local browser E2E

Use the requested worktree, not another agent's checkout. Follow `.node-version` and
the `packageManager` field in `package.json`; do not substitute older Node or pnpm
versions.

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm test:browser`. If Chromium is absent, run
   `pnpm exec playwright install --with-deps chromium` once and retry.
3. Use the repository harness from `playwright.config.ts` and
   `scripts/browser-server.mjs`. It owns the isolated HTTPS server and Cloudflare
   fixtures; do not start `pnpm dev`, create `.dev.vars`, or reuse a developer D1/R2
   state for this suite.
4. Keep the configured `app.ncf.test` and `content.ncf.test` origins distinct. The
   harness maps both to its local HTTPS listener, and the tests assert host routing,
   CSP, cookie, public-share, and content-origin boundaries.
5. Treat the seeded browser identity and storage as test fixtures, not as evidence
   for deployed Cloudflare Access, production cookies, custom domains, Queues,
   Images, or remote D1/R2 behavior.
6. For upload and download checks, verify the resulting bytes or hashes and the
   persisted UI state. Do not infer success from a toast, navigation, or HTTP status
   alone.
   The public shell may render a file name in both the breadcrumb `.path-button` and
   actionable listing `.node-button`; scope download locators to `.node-row
   .node-button` and assert the ticket request, content-origin `POST /session`,
   `GET /c/<nodeId>/<blobId>`, and exact downloaded bytes or hash.
7. Run a focused Playwright test while iterating, then run `pnpm test:browser` in
   full before reporting browser verification.
8. Preserve `test-results/` on failure and report the failing test title, trace, and
   screenshot. Do not weaken host isolation, HTTPS, or authentication fixtures to
   make a test pass.
9. Workerd may log `SSLV3_ALERT_CERTIFICATE_UNKNOWN` while Chromium uses the
   self-signed harness certificate. Judge delivery from request statuses and exact
   bytes, not this warning alone.

## Devin Secrets Needed

None for the isolated local browser suite. Deployed or multi-user verification
requires a separately approved environment and credentials.
