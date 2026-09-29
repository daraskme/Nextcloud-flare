import { parseArgs } from "node:util";
import { restoreBookmarkTimestamp } from "../packages/shared/src/restoreBookmark.ts";
import { RESTORE_DOMAIN_KINDS } from "../packages/shared/src/restoreDomain.ts";
import { restoreInventoryRequest } from "../packages/shared/src/restoreInventory.ts";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { adoptRestoreEpoch } from "./restore/adoption.mjs";
import { verifyRestoreBackups } from "./restore/backups.mjs";
import { verifyRestoreBindings } from "./restore/bindings.mjs";
import { verifyRestoreBlobs } from "./restore/blobs.mjs";
import { verifyRestoreBookmark } from "./restore/bookmark.mjs";
import { restoreErrorCode, restoreOperatorControl } from "./restore/control.mjs";
import { reserveRestoreEpoch } from "./restore/epoch.mjs";
import { freezeRestoreDatabase } from "./restore/freeze.mjs";
import { inventoryRestored } from "./restore/inventory.mjs";
import {
  auditRestored,
  rebuildRestoredFts,
  repairRestoredDomain,
  repairRestoredNative,
  resumeRestored,
} from "./restore/recovery.mjs";
import { verifyRestoredSnapshot } from "./restore/snapshot.mjs";
import { restoreD1Reader, verifyRestoreD1 } from "./restore/target.mjs";
import { applyRestoreTimeTravel, timeTravelProvider } from "./restore/timeTravel.mjs";
import {
  logicalSelection,
  restoreIdentity,
  restoreStatus,
  timeTravelSelection,
  verifyRestoreSelection,
} from "./restore/verify.mjs";

const usage = `Usage:
  pnpm database:restore prepare --operator-config JSON --local|--remote --epoch N --id UUID --source-id UUID --source-epoch N --manifest-sha256 HEX
  pnpm database:restore prepare --operator-config JSON --remote --epoch N --id UUID --bookmark BOOKMARK
  pnpm database:restore inspect|cancel --operator-config JSON --local|--remote --epoch N --id UUID
  pnpm database:restore verify --operator-config JSON --local --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore verify --operator-config JSON --remote --epoch N --id UUID
  pnpm database:restore verify-d1 --operator-config JSON --local|--remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore verify-bookmark --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID --timestamp YYYY-MM-DDTHH:mm:ss.sssZ
  pnpm database:restore verify-blobs --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore verify-backups|verify-bindings --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore freeze --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore reserve-epoch --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore apply-time-travel --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID --timestamp YYYY-MM-DDTHH:mm:ss.sssZ
  pnpm database:restore adopt-epoch --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore verify-restored --operator-config JSON --remote --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore audit-restored --operator-config JSON --remote --epoch N --id UUID [--max-pages 100] [--page-size 10]
  pnpm database:restore repair-restored-native --operator-config JSON --remote --epoch N --id UUID [--max-pages 100] [--page-size 10]
  pnpm database:restore repair-restored --operator-config JSON --remote --epoch N --id UUID --kind single|multipart|images|archives|reservations|outbox|blob-gc|orphan-gc|orphan-inventory [--limit 20]
  pnpm database:restore inventory-restored --operator-config JSON --remote --epoch N --id UUID --action verify|uploads|bucket|parts|abort [--limit 20] [--handle-id UUID] [--attempt-id UUID]
  pnpm database:restore rebuild-restored-fts --operator-config JSON --remote --epoch N --id UUID
  pnpm database:restore resume-restored --operator-config JSON --remote --epoch N --id UUID
  pnpm database:restore resume-restored-gc --operator-config JSON --remote --epoch N --id UUID

prepare pins the logical source or Time Travel bookmark and closes writes/GC. Keep the same request ID after an uncertain response.
verify checks up to 100 server-owned parts, then downloads and validates SQL/schema/all tables/FK/FTS in an isolated local database, and records the trusted verification in ControlDO.
Exit 2 means verification is incomplete; re-run the same request. Remote downloads use R2_BACKUP_* credentials.
cancel cancels preparation but keeps admission and GC closed. Failures never automatically cancel or reopen.
verify-d1 pins the configured DB target, renews the stop token and independently reads it with Wrangler before recording a five-minute D1 observation. Every retry uses a fresh challenge.
verify-bookmark performs fresh D1 verification and checks that Time Travel info at the explicit UTC timestamp returns the selected bookmark. This records a five-minute observation, not a retention guarantee or restore authorization.
The target must explicitly enable RESTORE_OPERATOR_ENABLED=true and grant the private database-restore-v1 capability.
verify-blobs checks fresh D1 identity, pins the configured BLOBS bucket and asks the Worker to rotate its fixed 64-byte system probe and read it through server-configured R2_INVENTORY_* credentials. This writes only the probe, not user files.
verify-backups pins BACKUPS and reads the Worker's fresh fixed probe using R2_BACKUP_* credentials. verify-bindings verifies D1, BLOBS and BACKUPS under one new stop challenge; both bucket targets must differ.
freeze verifies bindings and freezes D1 writes under the request ID. Repeat freeze to reconcile an unknown response; cancel thaws only this exact barrier while keeping maintenance/GC closed.
reserve-epoch requires prior source verification and D1 freeze. It pins one future epoch in DO/R2 under the same request, preserving D1's old epoch and freeze. Ordinary cancellation is disabled once reservation begins; inspect and retry the same ID after an unknown response.
apply-time-travel requires RESTORE_WRITE_ENABLED=true on the target and CLOUDFLARE_API_TOKEN locally. It destructively restores the pinned D1 database with one provider POST and records the native response. Unknown dispatches are never retried. This path is disabled by default; live operational I/O proof and end-to-end restoration validation remain release gates.
verify-restored independently reads the restored database, checks a trusted migration prefix and every table against an isolated SQL import, validates FK and rebuilds local FTS, then records a request-bound observation. It preserves the remote snapshot and old DO epoch. This observation is not an adoption or service-resume authorization.
adopt-epoch atomically stops the verified D1 snapshot at the reserved epoch, independently reads its new marker, and publishes that epoch in DO. Requires RESTORE_WRITE_ENABLED=true for the first write. Unknown D1 batches are never sent again; retry only reconciles the same marker. Admission and GC remain closed.
audit-restored rebuilds restored FTS when starting or restarting an audit, then advances bounded durable audit pages. Exit 2 means more pages remain; repeat the same request. Failed audits retain the hold and require the relevant repair. rebuild-restored-fts explicitly rebuilds FTS and restarts the audit.
repair-restored-native settles known live KDF/R2 completion records, then scans restored pending rows in durable pages against retained evidence. It restarts the audit, never repeats external I/O, and keeps unknown records pending. Exit 2 means pages, unknown work, or any DO/D1 hold remains. Repeating a finished pass starts a new scan.
repair-restored runs one bounded domain repair pass after adoption with RESTORE_WRITE_ENABLED=true. Native holds must be settled first. Single uploads retain their original expiry; multipart cleanup requires closure evidence before refunds. Images processes at most 8 derivatives per pass, retaining published outputs until source deletion, unknown native holds, physical accounting and 35-day GC grace. Stale reservations and supported outbox events use their original provenance. Blob/orphan GC only drains existing deletions, preserving pins and grace. Orphan inventory records one page without deleting objects. A failed RPC is never retried automatically. Exit 2 means an inventory walk is incomplete or domain holds remain, including ineligible uploads, inventory/GC handoffs or unsupported events. Full audit and separate resume commands remain required.
inventory-restored performs one fresh, request-bound multipart inventory action using server-configured S3 credentials and the adopted BLOBS target. uploads discovers/aborts stopped upload handles; bucket lists one page of operator handle IDs; parts needs --handle-id; abort needs --handle-id and a stable --attempt-id. Reusing that attempt ID does not resend abort. Parts and confirmed aborts retain capacity holds; empty listings are not closure proof. verify and abort reject --limit; uploads/bucket/parts accept 1..20. Native holds must be settled first; RESTORE_WRITE_ENABLED=true is required. No automatic retry or resume. Exit 2 means inventory holds or pages remain.
resume-restored requires the exact completed audit and a fresh final D1 fence, releases the restore hold, then opens admission with GC still paused. RESTORE_WRITE_ENABLED=true is required for first hold release. resume-restored-gc separately resumes GC last. All commands use the original epoch/request ID. A newer stop invalidates the old resume request. Live operational proof, unknown execution recovery and safe abandonment remain release gates.
`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "operator-config": { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      epoch: { type: "string" },
      id: { type: "string" },
      config: { type: "string" },
      environment: { type: "string" },
      "source-id": { type: "string" },
      "source-epoch": { type: "string" },
      "manifest-sha256": { type: "string" },
      bookmark: { type: "string" },
      timestamp: { type: "string" },
      "max-pages": { type: "string" },
      "page-size": { type: "string" },
      kind: { type: "string" },
      action: { type: "string" },
      "handle-id": { type: "string" },
      "attempt-id": { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    const command = positionals[0],
      common = ["operator-config", "local", "remote", "epoch", "id"],
      extra = {
        prepare: ["source-id", "source-epoch", "manifest-sha256", "bookmark"],
        inspect: [],
        cancel: [],
        verify: ["config", "environment"],
        "verify-d1": ["config", "environment"],
        "verify-bookmark": ["config", "environment", "timestamp"],
        "verify-blobs": ["config", "environment"],
        "verify-backups": ["config", "environment"],
        "verify-bindings": ["config", "environment"],
        freeze: ["config", "environment"],
        "reserve-epoch": ["config", "environment"],
        "apply-time-travel": ["config", "environment", "timestamp"],
        "verify-restored": ["config", "environment"],
        "adopt-epoch": ["config", "environment"],
        "audit-restored": ["max-pages", "page-size"],
        "repair-restored-native": ["max-pages", "page-size"],
        "repair-restored": ["kind", "limit"],
        "inventory-restored": ["action", "limit", "handle-id", "attempt-id"],
        "rebuild-restored-fts": [],
        "resume-restored": [],
        "resume-restored-gc": [],
      }[command];
    if (
      positionals.length !== 1 ||
      !extra ||
      !values["operator-config"] ||
      Object.keys(values).some((key) => ![...common, ...extra].includes(key)) ||
      !!values.local === !!values.remote ||
      !/^\d+$/.test(values.epoch ?? "") ||
      ([
        "audit-restored",
        "repair-restored-native",
        "repair-restored",
        "inventory-restored",
        "rebuild-restored-fts",
        "resume-restored",
        "resume-restored-gc",
      ].includes(command) &&
        !values.remote) ||
      (command === "repair-restored" &&
        (!RESTORE_DOMAIN_KINDS.includes(values.kind) ||
          (values.limit !== undefined &&
            (!/^\d+$/.test(values.limit) ||
              Number(values.limit) < 1 ||
              Number(values.limit) > 20)))) ||
      (values["max-pages"] !== undefined &&
        (!/^\d+$/.test(values["max-pages"]) ||
          Number(values["max-pages"]) < 1 ||
          Number(values["max-pages"]) > 100)) ||
      (values["page-size"] !== undefined &&
        (!/^\d+$/.test(values["page-size"]) ||
          Number(values["page-size"]) < 1 ||
          Number(values["page-size"]) > 20)) ||
      (command === "verify-d1" && !values.config) ||
      (["verify-bookmark", "apply-time-travel"].includes(command) &&
        (!values.remote || !values.config || !values.timestamp)) ||
      ([
        "verify-blobs",
        "verify-backups",
        "verify-bindings",
        "freeze",
        "reserve-epoch",
        "verify-restored",
        "adopt-epoch",
      ].includes(command) &&
        (!values.remote || !values.config)) ||
      (command === "verify" &&
        ((values.local && !values.config) ||
          (values.remote && (values.config || values.environment))))
    )
      throw new Error("database_restore_invalid_arguments");
    const epoch = Number(values.epoch),
      id = values.id;
    restoreIdentity(epoch, id);
    let inventoryRequest;
    if (command === "inventory-restored") {
      try {
        if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw new Error();
        inventoryRequest = restoreInventoryRequest({
          action: values.action,
          ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
          ...(values["handle-id"] === undefined ? {} : { handleId: values["handle-id"] }),
          ...(values["attempt-id"] === undefined ? {} : { attemptId: values["attempt-id"] }),
        });
      } catch {
        throw new Error("database_restore_invalid_arguments");
      }
    }
    let source;
    if (command === "prepare") {
      if (values.bookmark !== undefined) {
        if (
          !values.remote ||
          ["source-id", "source-epoch", "manifest-sha256"].some((key) => values[key] !== undefined)
        )
          throw new Error("database_restore_invalid_arguments");
        source = timeTravelSelection(values.bookmark);
      } else {
        if (!/^\d+$/.test(values["source-epoch"] ?? ""))
          throw new Error("invalid_database_restore");
        source = logicalSelection(
          values["source-id"],
          Number(values["source-epoch"]),
          values["manifest-sha256"],
        );
      }
    }
    if (["verify-bookmark", "apply-time-travel"].includes(command))
      restoreBookmarkTimestamp(values.timestamp, Date.now());
    const provider =
      command === "apply-time-travel"
        ? timeTravelProvider(process.env.CLOUDFLARE_API_TOKEN)
        : undefined;
    // Resolve and validate target configuration before making any private RPC.
    const reader = [
      "verify-d1",
      "verify-bookmark",
      "verify-blobs",
      "verify-backups",
      "verify-bindings",
      "freeze",
      "reserve-epoch",
      "apply-time-travel",
      "verify-restored",
      "adopt-epoch",
    ].includes(command)
      ? await restoreD1Reader({
          config: values.config,
          environment: values.environment,
          operatorConfig: values["operator-config"],
          mode: values.local ? "local" : "remote",
          snapshot: ["verify-restored", "adopt-epoch"].includes(command),
          blobs: [
            "verify-blobs",
            "verify-bindings",
            "freeze",
            "reserve-epoch",
            "apply-time-travel",
            "verify-restored",
            "adopt-epoch",
          ].includes(command),
          backups: [
            "verify-backups",
            "verify-bindings",
            "freeze",
            "reserve-epoch",
            "apply-time-travel",
            "verify-restored",
            "adopt-epoch",
          ].includes(command),
        })
      : undefined;
    let control;
    try {
      control = await restoreOperatorControl(
        values["operator-config"],
        values.local ? "local" : "remote",
      );
      let store;
      try {
        let result;
        if (["audit-restored", "repair-restored-native"].includes(command)) {
          result = await (command === "audit-restored" ? auditRestored : repairRestoredNative)({
            epoch,
            id,
            control,
            maxPages: Number(values["max-pages"] ?? 100),
            pageSize: Number(values["page-size"] ?? 10),
            progress: (event) => console.log(JSON.stringify(event)),
          });
          if (command === "audit-restored" ? !result.audit.completed : result.repair.pending)
            process.exitCode = 2;
        } else if (command === "repair-restored") {
          result = await repairRestoredDomain({
            epoch,
            id,
            kind: values.kind,
            limit: Number(values.limit ?? 20),
            control,
          });
          if (result.repair.pending) process.exitCode = 2;
        } else if (command === "inventory-restored") {
          result = await inventoryRestored({ epoch, id, request: inventoryRequest, control });
          if (result.inventory.pending) process.exitCode = 2;
        } else if (command === "rebuild-restored-fts") {
          result = await rebuildRestoredFts({ epoch, id, control });
        } else if (["resume-restored", "resume-restored-gc"].includes(command)) {
          result = await resumeRestored({
            epoch,
            id,
            control,
            gc: command === "resume-restored-gc",
          });
        } else if (command === "adopt-epoch") {
          result = await adoptRestoreEpoch({ epoch, id, control, reader });
        } else if (command === "verify-restored") {
          result = await verifyRestoredSnapshot({
            epoch,
            id,
            control,
            reader,
            progress: (event) => console.log(JSON.stringify(event)),
          });
        } else if (command === "apply-time-travel") {
          result = await applyRestoreTimeTravel({
            epoch,
            id,
            control,
            reader,
            timestamp: values.timestamp,
            provider,
          });
        } else if (command === "reserve-epoch") {
          result = await reserveRestoreEpoch({ epoch, id, control, reader });
        } else if (["verify-backups", "verify-bindings", "freeze"].includes(command)) {
          store = new S3BackupStore(process.env, { timeoutMs: 10000 });
          result = await (command === "freeze"
            ? freezeRestoreDatabase
            : command === "verify-backups"
              ? verifyRestoreBackups
              : verifyRestoreBindings)({ epoch, id, control, reader, store });
        } else if (command === "verify-blobs") {
          result = await verifyRestoreBlobs({ epoch, id, control, reader });
        } else if (command === "verify-bookmark") {
          result = await verifyRestoreBookmark({
            epoch,
            id,
            control,
            reader,
            timestamp: values.timestamp,
          });
        } else if (command === "verify-d1") {
          result = await verifyRestoreD1({ epoch, id, control, reader });
        } else if (command === "verify") {
          store = values.local
            ? await localBackupStore(values.config, values.environment)
            : new S3BackupStore(process.env);
          result = await verifyRestoreSelection({
            epoch,
            id,
            control,
            store,
            progress: (event) => console.log(JSON.stringify(event)),
          });
          if (!result.complete) process.exitCode = 2;
        } else {
          result = restoreStatus(
            await (command === "prepare"
              ? control.prepare(epoch, id, source)
              : control[command](epoch, id)),
            epoch,
            id,
          );
          if (command === "prepare" && JSON.stringify(result.source) !== JSON.stringify(source))
            throw new Error("database_restore_source_conflict");
          if (command === "cancel" && result.state !== "cancelled")
            throw new Error("database_restore_invalid_status");
        }
        console.log(JSON.stringify({ command, result }));
      } finally {
        try {
          await store?.dispose();
        } finally {
          await control.dispose();
        }
      }
    } finally {
      await reader?.dispose();
    }
  }
} catch (error) {
  console.error(
    `${restoreErrorCode(error)}: inspect the same restore request before retrying; admission remains closed after preparation. No automatic cancellation.`,
  );
  process.exitCode = 1;
}
