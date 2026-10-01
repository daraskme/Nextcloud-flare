import {
  normalizeBackupFailure,
  normalizeBackupResult,
  redactedReport,
  stateForFile,
  transitionEvent,
} from "./alertEvent.mjs";
import { readMonitorState, writeMonitorReport, writeMonitorState } from "./monitorState.mjs";

export async function runBackupMonitor({
  stateDirectory,
  execute,
  deliver,
  command = "maintain",
  observedAt = Date.now(),
}) {
  if (!stateDirectory || typeof stateDirectory !== "string")
    throw new Error("backup_monitor_state_directory_required");
  if (typeof execute !== "function" || typeof deliver !== "function")
    throw new Error("backup_monitor_invalid_request");
  const previous = await readMonitorState(stateDirectory);
  let normalized,
    backupExit = 0;
  try {
    const result = await execute();
    normalized = normalizeBackupResult({ command, result });
    backupExit = normalized.status.state === "healthy" ? 0 : 2;
  } catch (error) {
    normalized = normalizeBackupFailure(error);
    backupExit = 1;
  }
  const event = transitionEvent({ previous, normalized, observedAt });
  if (event) {
    await writeMonitorReport(
      stateDirectory,
      redactedReport({ normalized, deliveredEventId: event.eventId, delivery: "pending" }),
    );
    try {
      await deliver(event);
    } catch (error) {
      await writeMonitorReport(
        stateDirectory,
        redactedReport({ normalized, deliveredEventId: event.eventId, delivery: "failed" }),
      );
      throw error;
    }
  }
  await writeMonitorState(stateDirectory, stateForFile(normalized));
  await writeMonitorReport(
    stateDirectory,
    redactedReport({
      normalized,
      deliveredEventId: event?.eventId ?? null,
      delivery: event ? "delivered" : "suppressed",
    }),
  );
  return {
    exitCode: backupExit,
    deliveredEventId: event?.eventId ?? null,
    status: normalized.status,
  };
}
