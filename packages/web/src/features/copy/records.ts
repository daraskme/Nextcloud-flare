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
export function clearCopyRecords() {
  sessionStorage.removeItem(COPY_RECORDS_KEY);
  window.dispatchEvent(new Event(COPY_RECORDS_CHANGED));
}
