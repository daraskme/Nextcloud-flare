import type { UploadState } from "./contracts.js";

const transitions: Readonly<Record<UploadState, readonly UploadState[]>> = {
  created: ["receiving", "aborted", "expired"],
  receiving: ["completing", "aborted", "expired"],
  completing: ["completed", "failed"],
  completed: [],
  failed: [],
  aborted: [],
  expired: [],
};

export function canTransitionUpload(from: UploadState, to: UploadState): boolean {
  return transitions[from].includes(to);
}

export function assertUploadTransition(from: UploadState, to: UploadState): void {
  if (!canTransitionUpload(from, to)) {
    throw new Error(`Invalid upload transition: ${from} -> ${to}`);
  }
}
