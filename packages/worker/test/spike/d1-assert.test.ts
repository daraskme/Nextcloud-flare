import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyBatchFailure, reconcileCommit } from "../../src/db/outcome";
import { assertExists, assertOneChange, atomicBatch } from "../../src/db/primary";
import {
  createProbeSchema,
  mutationProbe,
  resetProbe,
  snapshot,
  statements,
  stepNames,
} from "../fixtures/d1-probe";
import badNode from "../fixtures/g01-node-revision.sql?raw";
import badTrash from "../fixtures/g01-trash-root.sql?raw";
import badTree from "../fixtures/g01-tree-generation.sql?raw";

beforeAll(createProbeSchema);
beforeEach(resetProbe);

it("changes() refers to the immediately preceding statement in a D1 batch", async () => {
  const results = await atomicBatch(env.DB, [
    { sql: "UPDATE nodes SET revision=revision+1 WHERE id='node'" },
    { sql: "SELECT changes() AS n" },
    { sql: "UPDATE nodes SET revision=revision+1 WHERE id='missing'" },
    { sql: "SELECT changes() AS n" },
  ]);
  expect(results[1]?.results).toEqual([{ n: 1 }]);
  expect(results[3]?.results).toEqual([{ n: 0 }]);
});

it("zero-row SQL alone commits the other writes (the original G01 bug)", async () => {
  await atomicBatch(env.DB, [
    { sql: "UPDATE nodes SET revision=revision+1 WHERE id='missing'" },
    { sql: "UPDATE users SET used_bytes=10 WHERE id='user'" },
  ]);
  expect(await env.DB.prepare("SELECT used_bytes FROM users").first("used_bytes")).toBe(10);
});

describe.each(["changes", "exists"] as const)("%s assertion barrier", (mode) => {
  it("commits every required step together", async () => {
    await atomicBatch(env.DB, mutationProbe(mode));
    expect(await env.DB.prepare("SELECT state FROM operations").first("state")).toBe("committed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM _assert").first("n")).toBe(0);
  });

  it.each(stepNames)("rolls back ALL side effects on a zero-row %s step", async (step) => {
    const before = await snapshot();
    await expect(atomicBatch(env.DB, mutationProbe(mode, step))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["G01-node", badNode],
    ["G01-tree", badTree],
  ])("%s rejects stale CAS", async (_id, sql) => {
    await atomicBatch(env.DB, statements(sql));
    const before = await snapshot();
    await expect(atomicBatch(env.DB, mutationProbe(mode))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("G01-trash: cannot publish trashed while its root is still live", async () => {
    await atomicBatch(env.DB, statements(badTrash));
    const before = await snapshot();
    await expect(
      atomicBatch(env.DB, [
        ...(mode === "exists"
          ? [assertExists("SELECT 1 FROM nodes WHERE id='node' AND revision=1")]
          : []),
        { sql: "UPDATE nodes SET deleted_at=1,revision=2 WHERE id='node' AND revision=1" },
        mode === "changes"
          ? assertOneChange
          : assertExists("SELECT 1 FROM nodes WHERE id='node' AND deleted_at=1 AND revision=2"),
        { sql: "UPDATE trash_ops SET state='trashed' WHERE op_id='trash'" },
      ]),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect(await snapshot()).toEqual(before);
  });
});

it("classifies an actual D1 CHECK rejection as a definite rollback", async () => {
  const before = await snapshot();
  try {
    await atomicBatch(env.DB, mutationProbe("changes", "terminal"));
    expect.unreachable("batch should fail");
  } catch (error) {
    expect(classifyBatchFailure(error)).toBe("rolled_back");
  }
  expect(await snapshot()).toEqual(before);
});

it("reconciles a lost acknowledgement after an actual commit without undoing it", async () => {
  try {
    await atomicBatch(env.DB, mutationProbe("changes"));
    throw new Error("Simulated transport loss AFTER D1 commit");
  } catch (error) {
    expect(classifyBatchFailure(error)).toBe("commit_unknown");
  }
  const outcome = await reconcileCommit(() =>
    env.DB.withSession("first-primary")
      .prepare("SELECT state,result_json,error_code FROM operations WHERE op_id='op'")
      .first(),
  );
  expect(outcome).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await env.DB.prepare("SELECT used_bytes FROM users").first("used_bytes")).toBe(10);
});

it("binds 100 values and rejects 101 before executing any statement", async () => {
  const sql = (count: number) =>
    `SELECT ${Array.from({ length: count }, (_, n) => `?${n + 1} AS c${n}`).join(",")}`;
  expect(
    (await atomicBatch(env.DB, [{ sql: sql(100), values: Array(100).fill(1) }]))[0]?.success,
  ).toBe(true);
  const before = await snapshot();
  await expect(
    atomicBatch(env.DB, [
      { sql: "UPDATE users SET used_bytes=99" },
      { sql: sql(101), values: Array(101).fill(1) },
    ]),
  ).rejects.toThrow(/100 bindings/);
  expect(await snapshot()).toEqual(before);
});
