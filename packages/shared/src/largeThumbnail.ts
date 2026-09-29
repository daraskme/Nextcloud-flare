export interface ThumbnailRequestReceipt {
  nodeId: string;
  blobId: string;
  variant: "lg" | "sm";
  generator: string;
  state: "pending" | "ready" | "unsupported" | "failed" | "absent";
}
export type LargeThumbnailReceipt = ThumbnailRequestReceipt & {
  variant: "lg";
  state: Exclude<ThumbnailRequestReceipt["state"], "absent">;
};
