import { OPERATION_SCOPE_TUPLES, OPERATIONS } from "@next-cloud-flare/shared/contracts";
import { expect, it } from "vitest";

it("declares source, destination and conditional overwrite scopes independently", () => {
  expect(OPERATION_SCOPE_TUPLES["node.move"]).toEqual([
    { operand: "source", when: "always", scopes: ["node:write"] },
    { operand: "destinationParent", when: "always", scopes: ["node:create"] },
    { operand: "overwriteTarget", when: "overwrite", scopes: ["node:delete"] },
  ]);
  expect(OPERATION_SCOPE_TUPLES["node.copy"]).toEqual([
    { operand: "source", when: "always", scopes: ["node:read"] },
    { operand: "destinationParent", when: "always", scopes: ["node:create"] },
    { operand: "overwriteTarget", when: "overwrite", scopes: ["node:delete"] },
  ]);
  expect(OPERATION_SCOPE_TUPLES["dav.move"]).toEqual(OPERATION_SCOPE_TUPLES["node.move"]);
  expect(OPERATION_SCOPE_TUPLES["dav.copy"]).toEqual(OPERATION_SCOPE_TUPLES["node.copy"]);
});

it("separates PUT create and overwrite plus LOCK existing and lock-null authority", () => {
  expect(OPERATION_SCOPE_TUPLES["dav.put"]).toEqual([
    { operand: "destinationParent", when: "create", scopes: ["node:create"] },
    { operand: "source", when: "overwrite", scopes: ["node:write"] },
  ]);
  expect(OPERATION_SCOPE_TUPLES["dav.lock"]).toEqual([
    { operand: "source", when: "existing", scopes: ["node:write"] },
    { operand: "sourceParent", when: "lock-null", scopes: ["node:create"] },
  ]);
});

it("keeps each flat operation scope declaration equal to its tuple union", () => {
  for (const [operation, tuples] of Object.entries(OPERATION_SCOPE_TUPLES)) {
    const tupleScopes = [...new Set(tuples.flatMap((tuple) => tuple.scopes))].sort();
    expect([...OPERATIONS[operation as keyof typeof OPERATIONS]].sort()).toEqual(tupleScopes);
  }
});
