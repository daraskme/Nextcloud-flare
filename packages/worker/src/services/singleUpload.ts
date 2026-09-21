import type { UploadState } from "@ncf/shared";

export function canStartSinglePut(state: UploadState, attemptRecorded: boolean): boolean {
  return state === "created" && !attemptRecorded;
}

export function reconcileExpiredSingle(headPresent: boolean): {
  uploadState: "expired" | "failed";
  blobState: "orphan" | null;
  releaseReservation: boolean;
} {
  return headPresent
    ? { uploadState: "failed", blobState: "orphan", releaseReservation: false }
    : { uploadState: "expired", blobState: null, releaseReservation: true };
}
