/** Durable copy progress. Completed bytes are checkpoints, not bytes already published. */
export interface CopyJobStatus {
  id: string;
  state: "pending" | "running" | "completed" | "cancelled" | "failed";
  nodeCount: number;
  blobCount: number;
  completedBlobs: number;
  completedBytes: number;
  totalBytes: number;
  cleanupPending: number;
  heldBytes: number;
  errorCode: string | null;
  publishedRootId: string | null;
  retryJobId: string | null;
}
