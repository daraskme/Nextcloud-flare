import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { purgeTrash } from "../../src/services/purge.js";
import { trashNode } from "../../src/services/trash.js";
import { restoreTrash } from "../../src/services/trashRestore.js";
import { seedFoundation } from "../helpers/foundation.js";

async function seedOperation(
  operationId: string,
  permitId: string,
  kind: string,
  expectedSteps: number,
): Promise<void> {
  const now = Date.now();
  const expires = now + 30_000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?1,'space',1,?2,'open')",
    ).bind(permitId, expires),
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES(?1,'user','user','as:session',NULL,'space',?2,'claimed',?3,1,?4,?5,?5,?6,NULL,NULL,?7,?7)",
    ).bind(operationId, kind, `digest-${operationId}`, permitId, expires, expectedSteps, now),
  ]);
}

function context(operationId: string, permitId: string) {
  return {
    operationId,
    permitId,
    epoch: 1,
    userId: "user",
    sessionId: "session",
    spaceId: "space",
    auditId: `audit-${operationId}`,
    outboxId: `outbox-${operationId}`,
  } as const;
}

beforeEach(async () => {
  await seedFoundation();
});

describe("restore, re-trash, and purge", () => {
  it("purges a node after a second trash cycle without weakening the current membership fence", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('folder','space','user','root','Folder','folder','folder',NULL,1,?1,?1,0)",
    )
      .bind(now)
      .run();

    await seedOperation("trash-1", "permit-trash-1", "node.trash", 7);
    await trashNode(env, {
      ...context("trash-1", "permit-trash-1"),
      trashOpId: "trash-cycle-1",
      nodeId: "folder",
      parentId: "root",
      expectedNodeRevision: 1,
      expectedParentRevision: 1,
      expectedTreeGeneration: 1,
      purgeAfter: 0,
    });

    await seedOperation("restore", "permit-restore", "node.restore", 7);
    await restoreTrash(env, {
      ...context("restore", "permit-restore"),
      trashOpId: "trash-cycle-1",
      destinationParentId: "root",
      expectedDestinationRevision: 2,
      expectedTreeGeneration: 2,
    });

    await seedOperation("trash-2", "permit-trash-2", "node.trash", 7);
    await trashNode(env, {
      ...context("trash-2", "permit-trash-2"),
      trashOpId: "trash-cycle-2",
      nodeId: "folder",
      parentId: "root",
      expectedNodeRevision: 3,
      expectedParentRevision: 3,
      expectedTreeGeneration: 3,
      purgeAfter: 0,
    });

    await seedOperation("purge", "permit-purge", "node.purge", 9);
    await expect(
      purgeTrash(env, {
        ...context("purge", "permit-purge"),
        trashOpId: "trash-cycle-2",
        expectedParentRevision: 4,
        expectedTreeGeneration: 4,
        gcNotBefore: 0,
      }),
    ).resolves.toBe(1);
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
    const operations = await env.DB.prepare(
      "SELECT op_id,state,(SELECT COUNT(*) FROM trash_members m WHERE m.trash_op_id=t.op_id) members FROM trash_ops t WHERE op_id IN ('trash-cycle-1','trash-cycle-2') ORDER BY op_id",
    ).all();
    expect(operations.results).toEqual([
      { op_id: "trash-cycle-1", state: "restored", members: 0 },
      { op_id: "trash-cycle-2", state: "purged", members: 0 },
    ]);
  });
});
