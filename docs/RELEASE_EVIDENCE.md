# Release evidence gate

`pnpm release:gate -- --plan` prints the fixed, sequential local command plan for CI and
operator review. Plan mode is not a release run: it always reports `passed: false`,
`releaseReady: false`, and `verdict: "plan-only"`.

A full local rehearsal requires an exact commit:

```sh
pnpm release:gate -- --ref "$(git rev-parse HEAD)"
```

The gate requires Node 24.21.0, pnpm 12.4.1, a clean worktree, the current exact HEAD,
and a lockfile identical to HEAD. It then runs frozen installation, `pnpm check`, all
three local backup drills, Playwright Chromium prerequisite validation, and
`pnpm test:browser` sequentially. It stops at the first mandatory failure. There is no
skip, partial-pass, concurrent, deploy, remote migration, secret, purge, live restore,
resource creation, or notification mode.

Every full attempt atomically replaces
`.release-evidence/release-gate-v1-<commit>.json` and its `.sha256` sidecar. The
manifest contains only the exact commit/ref, pinned tool versions, lockfile digest,
fixed command metadata, status/exit/signal/timing fields, and relative report
references. It does not capture command output, environment variables, credentials,
provider data, or absolute machine paths.

`passed: true` means only that the listed local gates passed for that exact clean
commit. `releaseReady` remains false. Cloudflare staging and production are always
recorded as `unverified`; deployment, Access/custom-domain behavior, remote D1/R2,
Queues, Images, platform limits, and production operations require separately
approved remote evidence.
