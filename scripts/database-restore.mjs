import { parseArgs } from "node:util";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { restoreErrorCode, restoreOperatorControl } from "./restore/control.mjs";
import { restoreD1Reader, verifyRestoreD1 } from "./restore/target.mjs";
import {
  logicalSelection,
  restoreIdentity,
  restoreStatus,
  verifyRestoreSelection,
} from "./restore/verify.mjs";

const usage = `Usage:
  pnpm database:restore prepare --operator-config JSON --local|--remote --epoch N --id UUID --source-id UUID --source-epoch N --manifest-sha256 HEX
  pnpm database:restore inspect|cancel --operator-config JSON --local|--remote --epoch N --id UUID
  pnpm database:restore verify --operator-config JSON --local --config PATH [--environment NAME] --epoch N --id UUID
  pnpm database:restore verify --operator-config JSON --remote --epoch N --id UUID
  pnpm database:restore verify-d1 --operator-config JSON --local|--remote --config PATH [--environment NAME] --epoch N --id UUID

prepare pins the logical source and closes writes/GC. Keep the same request ID after an uncertain response.
verify checks up to 100 server-owned parts, then downloads and validates SQL/schema/all tables/FK/FTS in an isolated local database, and records the trusted verification in ControlDO.
Exit 2 means verification is incomplete; re-run the same request. Remote downloads use R2_BACKUP_* credentials.
cancel cancels preparation but keeps admission and GC closed. Failures never automatically cancel or reopen.
verify-d1 pins the configured DB target, renews the stop token and independently reads it with Wrangler before recording a five-minute D1 observation. Every retry uses a fresh challenge.
The target must explicitly enable RESTORE_OPERATOR_ENABLED=true and grant the private database-restore-v1 capability.
These commands do not overwrite D1, reserve a new epoch, certify BLOBS bindings or resume service. Time Travel is not connected.
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
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    const command = positionals[0],
      common = ["operator-config", "local", "remote", "epoch", "id"],
      extra = {
        prepare: ["source-id", "source-epoch", "manifest-sha256"],
        inspect: [],
        cancel: [],
        verify: ["config", "environment"],
        "verify-d1": ["config", "environment"],
      }[command];
    if (
      positionals.length !== 1 ||
      !extra ||
      !values["operator-config"] ||
      Object.keys(values).some((key) => ![...common, ...extra].includes(key)) ||
      !!values.local === !!values.remote ||
      !/^\d+$/.test(values.epoch ?? "") ||
      (command === "verify-d1" && !values.config) ||
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
      if (!/^\d+$/.test(values["source-epoch"] ?? "")) throw new Error("invalid_database_restore");
      source = logicalSelection(
        values["source-id"],
        Number(values["source-epoch"]),
        values["manifest-sha256"],
      );
    }
    // Resolve and validate target configuration before making any private RPC.
    const reader =
      command === "verify-d1"
        ? await restoreD1Reader({
            config: values.config,
            environment: values.environment,
            operatorConfig: values["operator-config"],
            mode: values.local ? "local" : "remote",
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
        if (command === "verify-d1") {
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
