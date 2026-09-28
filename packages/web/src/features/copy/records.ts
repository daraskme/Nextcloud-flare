import { type SelectedShare, selectedShare } from "../../../../shared/src/shares";
import { type Account, ApiError, type Operation } from "../../lib/api";

export const COPY_RECORDS_KEY = "ncf-copy-jobs";
export const COPY_RECORDS_CHANGED = "ncf-copy-jobs-changed";
type Identity = Pick<Account, "id" | "epoch">;
export interface CopyRecord {
  id: string;
  accountId: string;
  epoch: number;
  name: string;
  destinationSpaceId: string;
  destinationParentId: string;
  destinationShare: SelectedShare | null;
  retryKey?: string;
  retriedJobId?: string;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function readCopyRecords(account: Identity): CopyRecord[] {
  const raw = sessionStorage.getItem(COPY_RECORDS_KEY);
  if (!raw) return [];
  try {
    if (raw.length > 200_000) throw new Error("invalid_copy_records");
    const rows = JSON.parse(raw) as CopyRecord[];
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("invalid_copy_records");
    return rows.filter((row) => {
      if (
        !row ||
        typeof row.id !== "string" ||
        !/^copy_[a-f0-9]{64}$/.test(row.id) ||
        row.accountId !== account.id ||
        row.epoch !== account.epoch ||
        typeof row.name !== "string" ||
        row.name.length > 255 ||
        !validId(row.destinationSpaceId) ||
        !validId(row.destinationParentId)
      )
        return false;
      if (
        (row.retryKey !== undefined && !/^[a-f0-9-]{36}$/.test(row.retryKey)) ||
        (row.retriedJobId !== undefined &&
          (!/^copy_[a-f0-9]{64}$/.test(row.retriedJobId) || row.retriedJobId === row.id))
      )
        return false;
      try {
        if (row.destinationShare !== null) selectedShare(row.destinationShare);
      } catch {
        return false;
      }
      return true;
    });
  } catch {
    return [];
  }
}
function write(rows: CopyRecord[]) {
  try {
    sessionStorage.setItem(COPY_RECORDS_KEY, JSON.stringify(rows));
  } catch {
    throw new ApiError(503, "copy_tracking_unavailable");
  }
  window.dispatchEvent(new Event(COPY_RECORDS_CHANGED));
}

/** Save the accepted job before removing the original pending mutation intent. */
export function rememberCopy(
  account: Identity,
  operation: Operation,
  body: Record<string, unknown>,
): void {
  if (!operation.result?.jobId && operation.result?.status !== 202) return;
  const id = operation.result?.jobId,
    destination = body.destination as { spaceId?: unknown; share?: unknown } | undefined;
  if (
    operation.state !== "committed" ||
    !id ||
    !/^copy_[a-f0-9]{64}$/.test(id) ||
    typeof body.name !== "string" ||
    body.name.length > 255 ||
    !validId(body.destinationParentId) ||
    !destination ||
    !validId(destination.spaceId)
  )
    throw new Error("invalid_copy_receipt");
  const record: CopyRecord = {
    id,
    accountId: account.id,
    epoch: account.epoch,
    name: body.name,
    destinationSpaceId: destination.spaceId,
    destinationParentId: body.destinationParentId,
    destinationShare: destination.share === null ? null : selectedShare(destination.share),
  };
  const rows = readCopyRecords(account).filter((row) => row.id !== id);
  if (rows.length >= 100) throw new ApiError(503, "copy_tracking_full");
  write([record, ...rows]);
}
export function forgetCopy(account: Identity, id: string) {
  write(readCopyRecords(account).filter((row) => row.id !== id));
}
/** Persist the retry intent before its POST; an uncertain request keeps this key. */
export function beginCopyRetry(account: Identity, id: string): string {
  const rows = readCopyRecords(account),
    record = rows.find((row) => row.id === id);
  if (!record || record.retriedJobId) throw new Error("invalid_copy_retry");
  if (record.retryKey) return record.retryKey;
  if (rows.length >= 100) throw new ApiError(503, "copy_tracking_full");
  const retryKey = crypto.randomUUID();
  write(rows.map((row) => (row.id === id ? { ...row, retryKey } : row)));
  return retryKey;
}
export function clearCopyRetry(account: Identity, id: string) {
  write(
    readCopyRecords(account).map((row) => {
      if (row.id !== id) return row;
      const { retryKey: _retryKey, ...rest } = row;
      return rest;
    }),
  );
}
/** Save the successor and acknowledge the old retry intent in one storage write. */
export function rememberCopyRetry(account: Identity, id: string, childId: string) {
  if (!/^copy_[a-f0-9]{64}$/.test(childId) || childId === id)
    throw new Error("invalid_copy_receipt");
  const rows = readCopyRecords(account),
    original = rows.find((row) => row.id === id);
  if (!original) throw new Error("invalid_copy_receipt");
  if (original.retriedJobId === childId) return;
  if (original.retriedJobId) throw new Error("invalid_copy_receipt");
  const { retryKey: _retryKey, retriedJobId: _child, ...base } = original;
  const child = rows.find((row) => row.id === childId) ?? { ...base, id: childId };
  const remaining = rows.filter((row) => row.id !== childId);
  if (remaining.length >= 100) throw new ApiError(503, "copy_tracking_full");
  write([
    child,
    ...remaining.map((row) => (row.id === id ? { ...base, retriedJobId: childId } : row)),
  ]);
}
export function clearCopyRecords() {
  sessionStorage.removeItem(COPY_RECORDS_KEY);
  window.dispatchEvent(new Event(COPY_RECORDS_CHANGED));
}
