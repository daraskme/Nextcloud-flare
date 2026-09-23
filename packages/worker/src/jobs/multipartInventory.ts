import { atomicBatch } from "../db/primary";
import type { InventorySource, R2S3Inventory } from "../r2/s3Inventory";
import type {
  MultipartInventoryPage,
  MultipartLifecycle,
  MultipartMarker,
  PartInventoryPage,
} from "../r2/s3InventoryPages";
import { controlFence } from "./uploadCleanup";

export type MultipartInventoryQuery =
  | { kind: "uploads"; prefix?: string; limit?: number; marker?: MultipartMarker | null }
  | { kind: "parts"; key: string; uploadId: string; limit?: number; marker?: number }
  | { kind: "lifecycle" };
export type MultipartInventoryObservation = {
  source: InventorySource;
  bindingVerified: false;
  closureProven: false;
} & (
  | { kind: "uploads"; page: MultipartInventoryPage }
  | { kind: "parts"; page: PartInventoryPage }
  | { kind: "lifecycle"; lifecycle: MultipartLifecycle }
);

/** One authenticated read under maintenance. Observations do not grant cleanup authority. */
export async function inspectMultipartInventory(
  db: D1Database,
  client: R2S3Inventory,
  epoch: number,
  query: MultipartInventoryQuery,
): Promise<MultipartInventoryObservation> {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !query ||
    !["uploads", "parts", "lifecycle"].includes(query.kind)
  )
    throw new Error("invalid_s3_inventory_request");
  await atomicBatch(db, [controlFence(epoch, true)]);
  const source = { source: client.source, bindingVerified: false, closureProven: false } as const;
  let observation: MultipartInventoryObservation;
  switch (query.kind) {
    case "uploads":
      observation = { ...source, kind: "uploads", page: await client.listMultipartUploads(query) };
      break;
    case "parts":
      observation = { ...source, kind: "parts", page: await client.listParts(query) };
      break;
    case "lifecycle":
      observation = {
        ...source,
        kind: "lifecycle",
        lifecycle: await client.getMultipartLifecycle(),
      };
      break;
  }
  // An old epoch's late network response cannot become a current recovery observation.
  await atomicBatch(db, [controlFence(epoch, true)]);
  return observation;
}
