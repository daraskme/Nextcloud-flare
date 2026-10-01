import { describe, expect, it } from "vitest";
import { parseTreeJobCheckpoint, parseTreeJobGrant, treeJobId } from "../../src/jobs/treeJobStore";

describe("tree job durable values", () => {
  it("derives the job identifier from the exact operation identifier", () => {
    expect(treeJobId(`op_${"a".repeat(64)}`)).toBe(`job_${"a".repeat(64)}`);
    expect(() => treeJobId("op_invalid")).toThrow("invalid_tree_job");
  });

  it("accepts only bounded checkpoints and exact saved grants", () => {
    expect(parseTreeJobCheckpoint('{"phase":"manifest","cursor":null}')).toEqual({
      phase: "manifest",
      cursor: null,
    });
    expect(() => parseTreeJobCheckpoint('{"phase":"other","cursor":null}')).toThrow(
      "invalid_tree_job",
    );
    const grant = {
      rootNodeId: "root",
      parentId: "parent",
      trashOpId: `op_${"b".repeat(64)}`,
      sourceTreeGeneration: 2,
      sourceRevision: 3,
      parentRevision: 4,
      lockTokenHashes: ["c".repeat(64)],
    };
    expect(parseTreeJobGrant(JSON.stringify(grant))).toEqual(grant);
    expect(() =>
      parseTreeJobGrant(JSON.stringify({ ...grant, lockTokenHashes: ["not-a-hash"] })),
    ).toThrow("invalid_tree_job");
  });
});
