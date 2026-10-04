# Runtime review follow-up — 2026-10-04

Environment revisions and deployment evidence live in [ENVIRONMENT_STATUS](../ENVIRONMENT_STATUS.md). Local test results below do not establish production readiness.

## Encrypted trash restoration

A regression test reproduced the reported bypass with real ControlDO/LockDO admission: ordinary restoration succeeded, and an encrypted child could also be restored after its parent had been shared. The fixture includes the search/FTS records required by a valid namespace mutation.

The restore service now checks encryption markers on the exact deleted trash members, the destination ancestry and shares rooted in the restored members. It repeats the same predicate in the atomic publication batch. Asynchronous tree jobs check it during processing and final publication. Every active share kind is covered. Disabled/expired shares remain valid private restoration destinations.

The focused restore/encryption/async/GC-pause suite passed 42 tests, including a share enabled between preflight and synchronous commit, and a 1,001-node asynchronous restoration whose destination becomes shared before finalization. Failure leaves the encrypted members in the trash. Ordinary unencrypted restoration remains allowed.

## Rejection diagnostics

The application callers of the reported `LockDO.acquireCreate` and `BudgetDO.reserve` paths await their results. In the affected local tests, workerd also reported deliberate callee rejection across the test RPC boundary. Those fixtures now catch the real DO decision inside `runInDurableObject`, transport a result value, and reproduce the rejection on the caller side. Assertions still verify rejection and persisted state; production authorization is unchanged.

`consumeKnownLength` also observes the separate Web Streams lifetime promises while its existing producer/consumer/digest `allSettled` continues to propagate the operation failure. This does **not** eliminate the two native workerd connection messages in the real R2 truncated-body regression.

`pnpm test:integration` now runs through `scripts/test/fail-on-unhandled.mjs`. Node rejection handling is strict, and unexpected workerd promise-rejection output makes the run fail even if Vitest exits zero. The real R2 short-body test runs first in its own fixed process: only that process permits at most two exact `Network connection lost` promise messages. The ordinary full/sharded suite excludes that one file and rejects every explicit unhandled-promise diagnostic. Both counts are printed. The short-body test still checks the real R2 rejection, absent object and refusal to complete or overwrite the failed upload.

The first combined CI revision (`c920122`) passed all 2,286 integration tests on Ubuntu but failed the new diagnostic gate. Ubuntu's bundled workerd reported a different native source line; Windows did not emit the native prefix. Revision `355f61b` confines the exception to the dedicated test process instead of depending on platform-specific log context. Its Ubuntu run then passed the isolated test and all 2,285 ordinary tests, but incorrectly counted nine handled native `pump canceled` diagnostics as unhandled promises. Revision `f38972f` counts the explicit promise marker, keeps all native output visible and preserves the child process's failure exit code. Eight classifier/runner tests cover those distinctions, split markers, strict Node rejection handling and the dedicated two-message limit.

The initial diagnostic full run passed 2,279 tests but correctly failed the newly introduced gate before the fixture corrections. It must not be cited as a final green run. After the platform correction, the dedicated real R2 test passed (expected platform messages: 2, unexpected: 0), and the 30 ordinary single-upload tests passed (expected: 0, unexpected: 0). Final combined-revision results belong in the environment status table.

## Public static assets

Public shell assets intentionally remain available during maintenance. They contain no file content or share credentials. The existing session/data endpoints continue to enforce maintenance and current authorization. A regression verifies that an existing share session cannot obtain file data after revocation, expiration or owner disablement, even if the static asset was cached. See [PUBLIC_SHARES](../PUBLIC_SHARES.md).

## PR #37 reconciliation

The chapter and operational tooling changes preserve the latest main authentication and encryption controls. The move-operation authority registry retains the original source-parent read check, and operation-result lookup retains the matching node-step check. Audio chapter reads and writes exclude authoritative encrypted blob markers, including when stale audio projections remain. The two new migrations use `0055` and `0056`; applied migrations are not renumbered.

The default backup service example keeps its existing behavior. The optional webhook CLI does not configure or send notifications unless explicitly invoked with a destination. The existing weekly automation uses local desktop notifications.

## WebDAV staging follow-up

A single authenticated `PROPFIND` returned 503 before creating a KDF attempt. Temporary staging diagnostics contained only fixed stage names and booleans. They showed that the Worker-generated five-second deadline was slightly beyond `DO Date.now() + 5000`; input types and lengths were valid and the request had not expired. The diagnostic code was removed after identification.

Revision `2a180af` retains expired/invalid-input rejection and clamps the effective dispatch deadline to the earlier of the caller's deadline and the DO's own five-second limit. D1's independent five-second cap remains. The caller also rejects a result arriving after its own deadline. The 23-test focused KDF suite passed, including an ahead-of-DO deadline, expired-request rejection and a late response. The deployed fix changed the same single-request staging probe to 207 success.

The real rclone 1.75.1 client then exposed a separate 400 response. A localhost capture using dummy credentials confirmed that it sends a PROPFIND XML body without `Content-Type`. Revision `1cf8681` accepts that form only through the existing bounded, strict PROPFIND parser. Explicit non-XML types, DTD/entity declarations and oversized bodies remain rejected. The XML unit suite passed eight tests, and the app-password integration suite passed 27 tests.

## Remote evidence boundaries

The dedicated Cloudflare fault harness is documented in [FAULT_DRILL](../../ops/staging/FAULT_DRILL.md). On 2026-10-04, actual Cron delivery, actual Queue retry/DLQ processing (one completed, one failed, one dead letter), R2 multipart completion/abort and byte hashes, and explicit ControlDO reset/recovery were observed. All six isolated resources were deleted and GET 404 was checked. The harness used 53 migrations through `0054`, before the PR's chapter migrations.

Initial setup was started by a private Queue bootstrap; subsequent Cron events reached the idempotent handler. Cron-only first setup, natural idle eviction of the application singleton, elapsed seven-day R2 lifecycle expiration and Windows/macOS OS-client compatibility remain unverified. A configured lifecycle rule does not prove elapsed expiration.

## Additional attached review

The attached report was based on an earlier revision (921 unit and 2,270 integration tests). Its encrypted-trash finding is covered by the fix and staging evidence above. The other eight findings are checked against the current source, independently of the report's claims. The report's temporary probe file was not present in this checkout; retained regression tests reproduce the relevant behavior.

| Finding | Change and boundary |
|---|---|
| DAV PUT validators | Evaluate strong `If-Match` and weak `If-None-Match` comparison, lists and `*` before reading the upload body. Preserve the atomic revision check at publication. Stale overwrite now returns 412. |
| Cumulative dead properties | Enforce at most 100 properties per node inside the same atomic mutation as the changes. An excess request rolls back; removals and replacements at the limit remain possible. |
| Share-session capacity | Reuse a valid existing cookie, and cap new sessions from one hashed source to eight while preserving the total 64-session bound. Expired/revoked sessions already do not consume active slots. Other valid sessions are never evicted. Shared NAT and distributed-source limits remain; see PUBLIC_SHARES. |
| Ticket issuance cost | Apply target-weighted EDGE admission before per-target D1/R2 work on private, public, admin and ZIP issuance. This is a best-effort edge limit, not a globally exact financial budget. |
| KDF recovery | Persist an explicit native-dispatch marker, await storage durability before native work, repair never-dispatched reservations, and reconcile exact D1 completion evidence after local receipt loss. Unknown native work without completion evidence in either store still blocks recovery; see below. |
| Exhausted tree jobs | Fail expired attempt-10 or invocation-200 jobs through an atomic terminal guard. An active lease, including one acquired during reconciliation, cannot be failed by this path. |
| Delegated group recipient | Require the delegator's active membership and visible group-share provenance, both before admission and in the publication transaction. Owner-created group shares keep their existing behavior. |
| COPY into source subtree | Explicitly reject a destination inside the source, with a bounded destination-ancestry check and an atomic recheck. The original finite snapshot implementation did not establish the report's claim of infinite recursion. |

### KDF evidence limits

The prior receipt had one `reserved` state for both a never-started request and potentially running native crypto. A new `dispatch_started` flag distinguishes new never-started reservations. Existing receipts default to started during the SQLite upgrade, preserving their uncertainty. Repair changes an unstarted reservation to `not_started` synchronously; a suspended handler must then fail its dispatch transition. Delayed D1 claims remain covered by the existing exact-token settlement and database write barrier.

The dispatch marker is flushed with `storage.sync()` before calling native crypto, then storage admission and the effective deadline are checked again. Actual completion can be recorded in D1 even if the old instance loses local storage access. A later repair accepts only matching immutable terminal evidence. Neither timeout nor eviction is completion evidence. If native execution starts and both stores lose its completion evidence, repair deliberately retains the hold and refuses audit/resume. This remaining availability limitation is not reported as fully fixed; releasing it would violate the outstanding-native-work bound. See [KDF_ADMISSION](../KDF_ADMISSION.md).

Final combined tests and deployed revisions are recorded in [ENVIRONMENT_STATUS](../ENVIRONMENT_STATUS.md).
