import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "../../src/services/fsMutation.js";
import { createFolderInput, seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
});

describe("Foundation create mutation", () => {
  it("commits node, revisions, audit, outbox, steps and terminal operation atomically", async () => {
    await createFolder(env, createFolderInput);
    const node = await env.DB.prepare(
      "SELECT id,revision,last_op_id FROM nodes WHERE id='folder'",
    ).first<{ id: string; revision: number; last_op_id: string }>();
    const operation = await env.DB.prepare(
      "SELECT state,(SELECT COUNT(*) FROM operation_steps WHERE op_id='operation') steps FROM operations WHERE op_id='operation'",
    ).first<{ state: string; steps: number }>();
    const space = await env.DB.prepare(
      "SELECT tree_generation FROM spaces WHERE id='space'",
    ).first<{ tree_generation: number }>();
    expect(node).toEqual({ id: "folder", revision: 1, last_op_id: "operation" });
    expect(operation).toEqual({ state: "committed", steps: 5 });
    expect(space?.tree_generation).toBe(2);
  });

  it("rolls back every mandatory step on a stale parent revision", async () => {
    await expect(
      createFolder(env, { ...createFolderInput, expectedParentRevision: 99 }),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
    const operation = await env.DB.prepare(
      "SELECT state FROM operations WHERE op_id='operation'",
    ).first<{ state: string }>();
    expect(operation?.state).toBe("claimed");
    const outbox = await env.DB.prepare("SELECT outbox_id FROM outbox").all();
    expect(outbox.results).toEqual([]);
  });
});
