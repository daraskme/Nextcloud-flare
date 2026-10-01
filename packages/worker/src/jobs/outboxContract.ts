export const OUTBOX_OPERATION_KINDS = {
  "node.created": [
    "node.create",
    "node.copy",
    "dav.mkcol",
    "dav.lock",
    "dav.put",
    "dav.copy",
    "upload.complete",
  ],
  "node.updated": ["dav.put", "upload.complete"],
  "node.trashed": ["node.trash", "dav.delete"],
  "node.restored": ["node.restore"],
  "node.purged": ["node.purge"],
  "node.renamed": ["node.rename", "node.move", "dav.move"],
} as const;

export type OutboxEventKind = keyof typeof OUTBOX_OPERATION_KINDS;
export type OutboxOperationKind = (typeof OUTBOX_OPERATION_KINDS)[OutboxEventKind][number];

export interface OutboxContractRow {
  readonly kind: string;
  readonly payload_ref: string;
  readonly op_kind: string;
  readonly operands_json: string;
  readonly result_json: string | null;
}

export interface OutboxOperands {
  readonly parentId: string;
  readonly nodeId?: string;
  readonly sourceNodeId?: string;
  readonly sourceParentId?: string;
  readonly overwriteTargetId?: string;
}

export interface OutboxResult {
  readonly status: number;
  readonly nodeId: string;
  readonly revision?: number;
}

export interface ValidOutboxContract {
  readonly eventKind: OutboxEventKind;
  readonly operationKind: OutboxOperationKind;
  readonly operands: OutboxOperands;
  readonly result: OutboxResult;
}

export const OUTBOX_PROVENANCE_SQL = `(
  (outbox.kind='node.created' AND o.kind IN ('node.create','node.copy','dav.mkcol','dav.lock','dav.put','dav.copy','upload.complete')) OR
  (outbox.kind='node.updated' AND o.kind IN ('dav.put','upload.complete')) OR
  (outbox.kind='node.trashed' AND o.kind IN ('node.trash','dav.delete')) OR
  (outbox.kind='node.restored' AND o.kind='node.restore') OR
  (outbox.kind='node.purged' AND o.kind='node.purge') OR
  (outbox.kind='node.renamed' AND o.kind IN ('node.rename','node.move','dav.move'))
)`;

export function isOutboxProvenance(kind: string, operationKind: string): boolean {
  if (!(kind in OUTBOX_OPERATION_KINDS)) return false;
  return (OUTBOX_OPERATION_KINDS[kind as OutboxEventKind] as readonly string[]).includes(
    operationKind,
  );
}

function expectedStatus(
  eventKind: OutboxEventKind,
  operationKind: OutboxOperationKind,
  operands: OutboxOperands,
): number {
  if (eventKind === "node.created")
    return (operationKind === "node.copy" || operationKind === "dav.copy") &&
      operands.overwriteTargetId
      ? 204
      : 201;
  if (eventKind === "node.updated" || eventKind === "node.trashed") return 204;
  if (eventKind === "node.restored" || eventKind === "node.purged") return 200;
  if (operationKind === "node.move" || operationKind === "dav.move")
    return operands.overwriteTargetId ? 204 : 201;
  return 200;
}

export function validateOutboxContract(row: OutboxContractRow): ValidOutboxContract | null {
  if (!isOutboxProvenance(row.kind, row.op_kind)) return null;
  try {
    const operands = JSON.parse(row.operands_json) as Record<string, unknown>;
    const result = JSON.parse(row.result_json ?? "null") as Record<string, unknown> | null;
    if (
      !operands ||
      typeof operands.parentId !== "string" ||
      !result ||
      result.nodeId !== row.payload_ref
    )
      return null;
    const eventKind = row.kind as OutboxEventKind;
    const operationKind = row.op_kind as OutboxOperationKind;
    const requiresNode =
      eventKind === "node.updated" ||
      eventKind === "node.trashed" ||
      eventKind === "node.restored" ||
      eventKind === "node.purged" ||
      eventKind === "node.renamed";
    if (
      (requiresNode && operands.nodeId !== row.payload_ref) ||
      (!requiresNode && operands.nodeId !== undefined)
    )
      return null;
    const copy = operationKind === "node.copy" || operationKind === "dav.copy";
    if (
      (copy && typeof operands.sourceNodeId !== "string") ||
      (!copy && operands.sourceNodeId !== undefined)
    )
      return null;
    const move = operationKind === "node.move" || operationKind === "dav.move";
    if (
      (move && typeof operands.sourceParentId !== "string") ||
      (!move && operands.sourceParentId !== undefined)
    )
      return null;
    if (
      operands.overwriteTargetId !== undefined &&
      (typeof operands.overwriteTargetId !== "string" ||
        (!copy && !move) ||
        operands.overwriteTargetId === row.payload_ref)
    )
      return null;
    const normalized: OutboxOperands = {
      parentId: operands.parentId,
      ...(typeof operands.nodeId === "string" ? { nodeId: operands.nodeId } : {}),
      ...(typeof operands.sourceNodeId === "string" ? { sourceNodeId: operands.sourceNodeId } : {}),
      ...(typeof operands.sourceParentId === "string"
        ? { sourceParentId: operands.sourceParentId }
        : {}),
      ...(typeof operands.overwriteTargetId === "string"
        ? { overwriteTargetId: operands.overwriteTargetId }
        : {}),
    };
    if (result.status !== expectedStatus(eventKind, operationKind, normalized)) return null;
    if (
      result.revision !== undefined &&
      (!Number.isSafeInteger(result.revision) || (result.revision as number) < 1)
    )
      return null;
    return {
      eventKind,
      operationKind,
      operands: normalized,
      result: {
        status: result.status as number,
        nodeId: row.payload_ref,
        ...(typeof result.revision === "number" ? { revision: result.revision } : {}),
      },
    };
  } catch {
    return null;
  }
}
