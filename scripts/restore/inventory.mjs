import {
  RESTORE_INVENTORY_ID,
  restoreInventoryRequest,
} from "../../packages/shared/src/restoreInventory.ts";
import { sameRecoveryStatus } from "./recovery.mjs";
import { restoreStatus } from "./verify.mjs";

/** One explicit operation, never an implicit abort retry or a capacity-release certificate. */
export async function inventoryRestored({ epoch, id, request: input, control }) {
  const request = restoreInventoryRequest(input);
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_unavailable");
  const raw = await control.repairInventory(epoch, id, request),
    status = sameRecoveryStatus(raw, selected),
    r = raw.inventory;
  const invalid = () => {
    throw new Error("database_restore_invalid_inventory_result");
  };
  if (
    status.state !== "epoch_adopted" ||
    !r ||
    r.action !== request.action ||
    typeof r.pending !== "boolean"
  )
    invalid();
  const count = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  const result = { action: request.action, pending: r.pending };
  if (request.action === "verify") {
    const v = r.verification;
    if (
      !v ||
      v.bindingVerified !== true ||
      !count(v.verifiedAt) ||
      v.verifiedAt < selected.snapshotVerifiedAt
    )
      invalid();
    result.verification = { bindingVerified: true, verifiedAt: v.verifiedAt };
  } else if (request.action === "uploads") {
    const u = r.uploads;
    if (
      !u ||
      !count(u.claimed, request.limit) ||
      !count(u.pages, u.claimed) ||
      !count(u.observed, u.pages * 20) ||
      !count(u.aborted, u.claimed * 10) ||
      !count(u.retried, u.claimed) ||
      !count(u.r2Calls, u.claimed * 13)
    )
      invalid();
    result.uploads = {
      claimed: u.claimed,
      pages: u.pages,
      observed: u.observed,
      aborted: u.aborted,
      retried: u.retried,
      r2Calls: u.r2Calls,
    };
  } else if (request.action === "bucket") {
    const b = r.bucket;
    if (
      !b ||
      !count(b.examined, request.limit) ||
      typeof b.completed !== "boolean" ||
      !Array.isArray(b.handles) ||
      b.handles.length !== b.examined ||
      (!b.completed && !r.pending) ||
      b.handles.some(
        (h) =>
          !h ||
          typeof h.id !== "string" ||
          !RESTORE_INVENTORY_ID.test(h.id) ||
          !["tracked", "quarantined"].includes(h.state),
      ) ||
      new Set(b.handles.map((h) => h.id)).size !== b.handles.length ||
      (b.handles.some((h) => h.state === "quarantined") && !r.pending)
    )
      invalid();
    result.bucket = {
      examined: b.examined,
      completed: b.completed,
      handles: b.handles.map((h) => ({ id: h.id, state: h.state })),
    };
  } else if (request.action === "parts") {
    const p = r.parts;
    if (
      !p ||
      !count(p.observed, request.limit) ||
      !count(p.heldBytes) ||
      typeof p.completed !== "boolean" ||
      !r.pending
    )
      invalid();
    result.parts = { observed: p.observed, heldBytes: p.heldBytes, completed: p.completed };
  } else {
    const a = r.abort;
    if (
      !a ||
      a.attemptId !== request.attemptId ||
      !["confirmed", "unconfirmed"].includes(a.outcome) ||
      typeof a.replayed !== "boolean" ||
      !count(a.heldBytes) ||
      !r.pending
    )
      invalid();
    result.abort = {
      attemptId: a.attemptId,
      outcome: a.outcome,
      replayed: a.replayed,
      heldBytes: a.heldBytes,
    };
  }
  return { ...status, inventory: result };
}
