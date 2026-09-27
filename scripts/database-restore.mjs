import { parseArgs } from "node:util";
import { restoreBookmarkTimestamp } from "../packages/shared/src/restoreBookmark.ts";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { verifyRestoreBackups } from "./restore/backups.mjs";
import { verifyRestoreBindings } from "./restore/bindings.mjs";
import { verifyRestoreBlobs } from "./restore/blobs.mjs";
import { verifyRestoreBookmark } from "./restore/bookmark.mjs";
import { restoreErrorCode, restoreOperatorControl } from "./restore/control.mjs";
import { reserveRestoreEpoch } from "./restore/epoch.mjs";
import { freezeRestoreDatabase } from "./restore/freeze.mjs";
import { restoreD1Reader, verifyRestoreD1 } from "./restore/target.mjs";
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
These commands do not overwrite D1, adopt the reserved epoch, prove all external I/O has finished or resume service.
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
      }[command];
    if (
      positionals.length !== 1 ||
      !extra ||
      !values["operator-config"] ||
      Object.keys(values).some((key) => ![...common, ...extra].includes(key)) ||
      !!values.local === !!values.remote ||
      !/^\d+$/.test(values.epoch ?? "") ||
      (command === "verify-d1" && !values.config) ||
      (command === "verify-bookmark" && (!values.remote || !values.config || !values.timestamp)) ||
      (["verify-blobs", "verify-backups", "verify-bindings", "freeze", "reserve-epoch"].includes(
        command,
      ) &&
        (!values.remote || !values.config)) ||
      (command === "verify" &&
        ((values.local && !values.config) ||
          (values.remote && (values.config || values.environment))))
    )
      throw new Error("database_restore_invalid_arguments");
    const epoch = Number(values.epoch),
      id = values.id;
    restoreIdentity(epoch, id);
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
    if (command === "verify-bookmark") restoreBookmarkTimestamp(values.timestamp, Date.now());
    // Resolve and validate target configuration before making any private RPC.
    const reader = [
      "verify-d1",
      "verify-bookmark",
      "verify-blobs",
      "verify-backups",
      "verify-bindings",
      "freeze",
      "reserve-epoch",
    ].includes(command)
      ? await restoreD1Reader({
          config: values.config,
          environment: values.environment,
          operatorConfig: values["operator-config"],
          mode: values.local ? "local" : "remote",
          blobs: ["verify-blobs", "verify-bindings", "freeze", "reserve-epoch"].includes(command),
          backups: ["verify-backups", "verify-bindings", "freeze", "reserve-epoch"].includes(
            command,
          ),
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
        if (command === "reserve-epoch") {
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
