import { expect, it } from "vitest";
import {
  OUTBOX_OPERATION_KINDS,
  type OutboxEventKind,
  validateOutboxContract,
} from "../../src/jobs/outboxContract";

function row(eventKind: OutboxEventKind, operationKind: string) {
  const nodeId = "node";
  const operands: Record<string, string> = { parentId: "parent" };
  if (eventKind !== "node.created") operands.nodeId = nodeId;
  if (operationKind === "node.copy" || operationKind === "dav.copy")
    operands.sourceNodeId = "source";
  if (operationKind === "node.move" || operationKind === "dav.move")
    operands.sourceParentId = "source-parent";
  const status =
    eventKind === "node.created"
      ? 201
      : eventKind === "node.updated" || eventKind === "node.trashed"
        ? 204
        : eventKind === "node.renamed" &&
            (operationKind === "node.move" || operationKind === "dav.move")
          ? 201
          : 200;
  return {
    kind: eventKind,
    payload_ref: nodeId,
    op_kind: operationKind,
    operands_json: JSON.stringify(operands),
    result_json: JSON.stringify({ status, nodeId }),
  };
}

it("validates every emitted event and originating operation kind", () => {
  for (const [eventKind, operations] of Object.entries(OUTBOX_OPERATION_KINDS)) {
    for (const operationKind of operations)
      expect(
        validateOutboxContract(row(eventKind as OutboxEventKind, operationKind)),
      ).toMatchObject({
        eventKind,
        operationKind,
        result: { nodeId: "node" },
      });
  }
});

it.each([
  ["unknown event", { ...row("node.created", "node.create"), kind: "other" }],
  ["wrong operation", { ...row("node.created", "node.create"), op_kind: "node.rename" }],
  [
    "wrong result node",
    {
      ...row("node.created", "node.create"),
      result_json: JSON.stringify({ status: 201, nodeId: "other" }),
    },
  ],
  [
    "wrong result status",
    {
      ...row("node.trashed", "node.trash"),
      result_json: JSON.stringify({ status: 200, nodeId: "node" }),
    },
  ],
  [
    "missing source",
    {
      ...row("node.created", "node.copy"),
      operands_json: JSON.stringify({ parentId: "parent" }),
    },
  ],
  [
    "missing source parent",
    {
      ...row("node.renamed", "node.move"),
      operands_json: JSON.stringify({ parentId: "parent", nodeId: "node" }),
    },
  ],
  [
    "unexpected overwrite",
    {
      ...row("node.created", "node.create"),
      operands_json: JSON.stringify({ parentId: "parent", overwriteTargetId: "old" }),
    },
  ],
] as const)("rejects %s", (_name, contractRow) => {
  expect(validateOutboxContract(contractRow)).toBeNull();
});

it("requires overwrite status and keeps overwrite distinct from the payload", () => {
  const contractRow = row("node.renamed", "node.move");
  expect(
    validateOutboxContract({
      ...contractRow,
      operands_json: JSON.stringify({
        parentId: "parent",
        nodeId: "node",
        sourceParentId: "source-parent",
        overwriteTargetId: "old",
      }),
      result_json: JSON.stringify({ status: 204, nodeId: "node" }),
    }),
  ).not.toBeNull();
  expect(
    validateOutboxContract({
      ...contractRow,
      operands_json: JSON.stringify({
        parentId: "parent",
        nodeId: "node",
        sourceParentId: "source-parent",
        overwriteTargetId: "node",
      }),
    }),
  ).toBeNull();
});
