# Isolated Cloudflare fault drill

This drill uses a fresh UUID for a private Worker, D1, two R2 buckets, a Queue and a DLQ. It never binds the application D1 or buckets. The Worker has no route, `workers_dev` or preview URL, and its `fetch` handler returns 404. Run it only with a private `0700` ledger directory and `0600` ledger file under ignored `.wrangler/fault-drill/<uuid>/`. Provisioning discovers all local migration files, checks that remote `d1_migrations` is an exact prefix, and imports only the suffix in trigger-safe batches. The completed 2026-10-04 staging drill used 53 files through `0054_encryption_identity.sql`; later migrations on another branch were not in that run.

## Scope and evidence

The scheduled handler uses the real `ControlDO`, `LockDO`, `createFolder` and outbox dispatch code. It seeds one synthetic user/space in the dedicated D1, runs Control recovery and audit, creates two folders and dispatches their outbox records. The primary Queue consumer calls the production `handleOutboxBatch`. For one fixed outbox ID, the private wrapper injects a D1 read failure before the production handler sees the record; Cloudflare retries it twice, then delivers it to the DLQ. The DLQ consumer calls production `handleDeadLetterBatch` against the real dedicated D1 and ControlDO. The other outbox finishes normally. The setup is durably claimed once before any remote mutation; an unknown outcome stays stopped for investigation.

In the completed run, no scheduled event appeared during two initial bounded tails. A single private Queue bootstrap created the fixture after an exact empty-D1 check. Later Cloudflare `scheduled` events reached the Worker and called the same durably claimed handler, which returned without duplicating work. Thus provider Cron delivery and idempotent re-entry were observed, while first-time setup from Cron alone was not. The final dedicated D1 counts were `completed=1`, `failed=1`, `outbox_dead_letters=1`, `epoch=2`.

The R2 drill uses the dedicated blobs bucket. It completes a two-part object (5 MiB then a short final part), verifies HEAD/GET length and SHA-256, aborts a second multipart upload, verifies the aborted key is absent, and deletes the completed object. This proves provider multipart API behavior and explicit abort. Read the [R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/) to record the effective incomplete-upload abort rule. Its configured age does **not** prove elapsed expiration.

The private `ControlDO` subclass exposes only a fixed-RUN-ID RPC probe. It reads status and completed recovery audit, invokes the documented [`ctx.abort()` reset](https://developers.cloudflare.com/durable-objects/api/state/) on its own dedicated instance, obtains a fresh stub, then requires a new in-memory nonce and unchanged Control status, completed audit, and D1 mirror fields. The completed run observed the abort and `fault_drill_eviction_passed`. This proves explicit reset and recovery of this isolated instance, not arbitrary idle eviction of the application singleton. WebDAV tests driven by curl/rclone/davfs cannot establish macOS or Windows Finder/Explorer compatibility.

## Commands

Use the pinned Node/Wrangler toolchain and a private Cloudflare API token that has only the existing staging automation rights. Source it in the shell without echoing values. No command takes the application D1 ID or bucket names.

```sh
node ops/staging/fault-config.test.mjs
pnpm exec tsc --noEmit -p ops/staging/fault-tsconfig.json
pnpm exec biome check ops/staging/fault-*

# First create a private ledger with crypto.randomUUID(), version=1,
# names=resourceNames(id), created=[]. Keep it outside tracked files.
node ops/staging/fault-provision.mjs --provision .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-provision.mjs --inspect .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-provision.mjs --arm .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-r2.mjs --execute .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-provision.mjs --inspect .wrangler/fault-drill/<uuid>/ledger.json
# If Cron has not reached the Worker and the dedicated D1 remains exactly empty,
# one private Queue bootstrap is allowed. Never resend an unknown outcome.
node ops/staging/fault-provision.mjs --bootstrap .wrangler/fault-drill/<uuid>/ledger.json
# Only after exact terminal D1 counts: one completed, one failed, one dead letter.
node ops/staging/fault-provision.mjs --probe .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-observe.mjs --inspect .wrangler/fault-drill/<uuid>/ledger.json
node ops/staging/fault-cleanup.mjs --cleanup-owned .wrangler/fault-drill/<uuid>/ledger.json
```

`--provision` creates each UUID-owned resource and records it before moving on. It imports all local D1 migrations using the documented trigger-safe path, then deploys the Worker with `FAULT_ARMED=false`. `--arm` is a separate exact deployment. Cloudflare documents [Cron propagation delay](https://developers.cloudflare.com/workers/configuration/cron-triggers/); observe the dedicated Worker tail and D1 aggregates rather than treating a quiet tail as success. Run `--bootstrap` only once after an exact empty-state inspection and preserve the ledger if delivery is unknown. `--resume` exists for a manually diagnosed partial setup only and requires one synthetic user/root, no operations or outbox rows, epoch 2 and open admission. The private Worker logs fixed stage codes. `fault-observe.mjs` tries a read-only remote Durable Object binding; if this Wrangler transport fails, D1 and Worker tail remain the source of evidence.

`--cleanup-owned` first verifies and detaches only Queue consumers whose queue and script match the UUID ledger. Cloudflare refuses Worker deletion while it is a Queue consumer (API code 10064). It then deletes the Worker and its dedicated DO namespaces, the queues, and only the two dedicated buckets and D1 recorded in the ledger. It checks bucket keys against a narrow allowlist and stops on any unknown object or in-progress multipart upload. Keep the ledger if cleanup stops; resolve the exact isolated object and resume the same command. Cloudflare [requires a bucket to be empty and have no in-progress multipart upload before deletion](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/). The completed run reported `removed=6,total=6`.

## Limits

- The injected D1 error is at the private wrapper boundary. It verifies the production handler's retry choice and provider Queue/DLQ delivery, not a regional D1 outage.
- The forced `ctx.abort()` test establishes recreation of the isolated subclass only. Natural idle eviction of the production singleton remains untested.
- R2 lifecycle expiration requires elapsed days. The explicit multipart abort and cleanup here are immediate operations.
- No real WebDAV OS client is invoked. Linux read-only clients and macOS/Windows OS interoperability remain distinct staging evidence tasks.
