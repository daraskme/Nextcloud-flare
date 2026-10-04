import { describe, expect, it } from "vitest";
import {
  DURABLE_OPERATION_KINDS,
  OPERATION_AUTHORITY_POLICIES,
  operationAuthorityPlan,
} from "../../src/jobs/operationAuthority";

const OPERANDS = {
  "node.create": { parentId: "parent" },
  "dav.mkcol": { parentId: "parent" },
  "dav.lock": { parentId: "parent" },
  "dav.put": { parentId: "parent" },
  "upload.complete": { parentId: "parent", uploadId: "upload" },
  "dav.delete": { nodeId: "node", parentId: "parent" },
  "dav.copy": { sourceNodeId: "source", parentId: "parent", name: "copy", depth: "0" },
  "dav.move": {
    nodeId: "node",
    sourceParentId: "source-parent",
    parentId: "parent",
    name: "move",
  },
  "node.copy": {
    sourceNodeId: "source",
    parentId: "parent",
    name: "copy",
    depth: "infinity",
  },
  "node.move": {
    nodeId: "node",
    sourceParentId: "source-parent",
    parentId: "parent",
    name: "move",
  },
  "node.trash": { nodeId: "node", parentId: "parent" },
  "node.restore": { trashOpId: "trash", nodeId: "node", parentId: "parent" },
  "node.purge": { trashOpId: "trash", nodeId: "node", parentId: "parent" },
  "node.rename": { nodeId: "node", parentId: "parent" },
  "dav.proppatch": { nodeId: "node" },
} as const;

describe("durable operation authority registry", () => {
  it("has one complete executable policy for every durable operation", () => {
    expect(Object.keys(OPERATION_AUTHORITY_POLICIES).sort()).toEqual(
      [...DURABLE_OPERATION_KINDS].sort(),
    );
    for (const kind of DURABLE_OPERATION_KINDS) {
      const policy = OPERATION_AUTHORITY_POLICIES[kind];
      expect(Object.keys(policy.operands).length).toBeGreaterThan(0);
      expect(policy.claim.length).toBeGreaterThan(0);
      expect(policy.claim.every((rule) => rule.operation && rule.operand && rule.when)).toBe(true);
      expect(policy.adapters.length).toBeGreaterThan(0);
      expect(["outbox", "proppatch"]).toContain(policy.terminalResult);
      expect(policy.resultAuthority).toBe("node.read");
      expect(
        operationAuthorityPlan(kind, JSON.stringify(OPERANDS[kind]), "claimed"),
      ).not.toBeNull();
    }
  });

  it("resolves conditional claim and lookup authority through the same interpreter", () => {
    expect(
      operationAuthorityPlan(
        "upload.complete",
        JSON.stringify({ parentId: "parent", uploadId: "upload" }),
        "claimed",
      )?.claim,
    ).toMatchObject([{ operation: "node.create", operand: "parentId" }]);
    expect(
      operationAuthorityPlan(
        "upload.complete",
        JSON.stringify({ parentId: "parent", uploadId: "upload", nodeId: "node" }),
        "claimed",
      )?.claim,
    ).toMatchObject([
      { operation: "node.content.write", operand: "nodeId", expectedParent: "parentId" },
    ]);
    expect(
      operationAuthorityPlan(
        "node.move",
        JSON.stringify({ ...OPERANDS["node.move"], overwriteTargetId: "overwrite" }),
        "claimed",
      )?.claim,
    ).toHaveLength(3);
    expect(
      operationAuthorityPlan("node.restore", JSON.stringify(OPERANDS["node.restore"]), "committed")
        ?.lookup,
    ).toMatchObject([{ operation: "node.rename", operand: "nodeId", expectedParent: "parentId" }]);
  });

  it("rejects malformed, incomplete, inconsistent, and undeclared operands", () => {
    expect(operationAuthorityPlan("node.rename", "{", "claimed")).toBeNull();
    expect(
      operationAuthorityPlan("node.rename", JSON.stringify({ nodeId: "node" }), "claimed"),
    ).toBeNull();
    expect(
      operationAuthorityPlan(
        "node.rename",
        JSON.stringify({ nodeId: "node", parentId: 7 }),
        "claimed",
      ),
    ).toBeNull();
    expect(
      operationAuthorityPlan(
        "node.rename",
        JSON.stringify({ nodeId: "node", parentId: "parent", sourceNodeId: "extra" }),
        "claimed",
      ),
    ).toBeNull();
    expect(
      operationAuthorityPlan(
        "node.copy",
        JSON.stringify({ ...OPERANDS["node.copy"], depth: "1" }),
        "claimed",
      ),
    ).toBeNull();
  });
});
