export interface LargeThumbnailReceipt {
  nodeId: string;
  blobId: string;
  variant: "lg";
  generator: string;
  state: "pending" | "ready" | "unsupported" | "failed";
}
