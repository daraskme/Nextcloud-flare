# Runtime review follow-up — 2026-10-04

Environment revisions and deployment evidence live in [ENVIRONMENT_STATUS](../ENVIRONMENT_STATUS.md). Local test results below do not establish production readiness.

## Encrypted trash restoration

A regression test reproduced the reported bypass with real ControlDO/LockDO admission: ordinary restoration succeeded, and an encrypted child could also be restored after its parent had been shared. The fixture includes the search/FTS records required by a valid namespace mutation.

The restore service now checks encryption markers on the exact deleted trash members, the destination ancestry and shares rooted in the restored members. It repeats the same predicate in the atomic publication batch. Asynchronous tree jobs check it during processing and final publication. Every active share kind is covered. Disabled/expired shares remain valid private restoration destinations.

The focused restore/encryption/async/GC-pause suite passed 42 tests, including a share enabled between preflight and synchronous commit, and a 1,001-node asynchronous restoration whose destination becomes shared before finalization. Failure leaves the encrypted members in the trash. Ordinary unencrypted restoration remains allowed.

## Rejection diagnostics

The application callers of the reported `LockDO.acquireCreate` and `BudgetDO.reserve` paths await their results. In the affected local tests, workerd also reported deliberate callee rejection across the test RPC boundary. Those fixtures now catch the real DO decision inside `runInDurableObject`, transport a result value, and reproduce the rejection on the caller side. Assertions still verify rejection and persisted state; production authorization is unchanged.

`consumeKnownLength` also observes the separate Web Streams lifetime promises while its existing producer/consumer/digest `allSettled` continues to propagate the operation failure. This does **not** eliminate the two native workerd connection messages in the real R2 truncated-body regression.

`pnpm test:integration` now runs through `scripts/test/fail-on-unhandled.mjs`. Node rejection handling is strict, and unexpected workerd promise-rejection output makes the run fail even if Vitest exits zero. One pinned-runtime diagnostic is classified separately: the exact native fixed-length-pipe diagnostic, optional native stack lines, then at most two exact `Network connection lost` rejection lines in the same output stream. An unrelated error, another output stream, an intervening line or a third rejection fails the gate. Both counts are always printed. These two platform messages remain visible; they are not evidence of an unhandled application promise.

The diagnostic full run passed 2,279 tests but correctly failed the newly introduced gate before the fixture corrections. It must not be cited as a final green run. After correction, the three affected DO suites and the unchanged real R2 short-body test passed (57 tests); the runner itself passed seven tests. Final combined-revision results belong in the environment status table.

## Public static assets

Public shell assets intentionally remain available during maintenance. They contain no file content or share credentials. The existing session/data endpoints continue to enforce maintenance and current authorization. A regression verifies that an existing share session cannot obtain file data after revocation, expiration or owner disablement, even if the static asset was cached. See [PUBLIC_SHARES](../PUBLIC_SHARES.md).

## PR #37 reconciliation

The chapter and operational tooling changes preserve the latest main authentication and encryption controls. The move-operation authority registry retains the original source-parent read check, and operation-result lookup retains the matching node-step check. Audio chapter reads and writes exclude authoritative encrypted blob markers, including when stale audio projections remain. The two new migrations use `0055` and `0056`; applied migrations are not renumbered.

The default backup service example keeps its existing behavior. The optional webhook CLI does not configure or send notifications unless explicitly invoked with a destination. The existing weekly automation uses local desktop notifications.

## Remote evidence boundaries

The dedicated Cloudflare fault harness is documented in [FAULT_DRILL](../../ops/staging/FAULT_DRILL.md). Its evidence must distinguish actual Cron delivery, actual Queue retry/DLQ processing, R2 explicit multipart completion/abort, configured lifecycle rules and observed ControlDO recreation. A configured lifecycle rule does not prove elapsed expiration. Linux protocol checks do not establish Windows/macOS OS-client compatibility.
