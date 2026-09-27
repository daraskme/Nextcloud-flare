export type RestoreInventoryRequest =
  | { action: "verify" }
  | { action: "uploads"; limit: number }
  | { action: "bucket"; limit: number }
  | { action: "parts"; handleId: string; limit: number }
  | { action: "abort"; handleId: string; attemptId: string };

export const RESTORE_INVENTORY_ACTIONS = ["verify", "uploads", "bucket", "parts", "abort"] as const;
export const RESTORE_INVENTORY_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

/** Accept only explicit actions and server-owned handle IDs, never keys/endpoints/credentials. */
export function restoreInventoryRequest(input: unknown): RestoreInventoryRequest {
  const invalid = (): never => {
    throw new Error("database_restore_invalid_inventory_request");
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const r = input as Record<string, unknown>;
  if (!RESTORE_INVENTORY_ACTIONS.includes(r.action as never)) return invalid();
  const paged = ["uploads", "bucket", "parts"].includes(r.action as string);
  const handle = r.action === "parts" || r.action === "abort";
  const allowed = [
    "action",
    ...(paged ? ["limit"] : []),
    ...(handle ? ["handleId"] : []),
    ...(r.action === "abort" ? ["attemptId"] : []),
  ];
  const limit = r.limit === undefined ? 20 : r.limit;
  if (
    Object.keys(r).some((key) => !allowed.includes(key)) ||
    (paged && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20)) ||
    (handle && (typeof r.handleId !== "string" || !RESTORE_INVENTORY_ID.test(r.handleId))) ||
    (r.action === "abort" &&
      (typeof r.attemptId !== "string" || !RESTORE_INVENTORY_ID.test(r.attemptId)))
  )
    return invalid();
  return {
    action: r.action,
    ...(paged ? { limit } : {}),
    ...(handle ? { handleId: r.handleId } : {}),
    ...(r.action === "abort" ? { attemptId: r.attemptId } : {}),
  } as RestoreInventoryRequest;
}
