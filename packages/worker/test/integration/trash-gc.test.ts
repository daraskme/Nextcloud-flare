import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { runGarbageCollection } from "../../src/services/gc.js";
import { purgeTrash } from "../../src/services/purge.js";
import { pinBlob } from "../../src/services/refs.js";
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

describe("trash, purge and GC", () => {
  it("fixes live membership, preserves an independently deleted child, and restores last", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',4,'\"b-blob\"',1,'committed',?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('folder','space','user','root','Docs','docs','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('file','space','user','folder','file.txt','file.txt','file','blob',1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES('foreign-trash','user','space','foreign-child','trashed',?1,1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,deleted_op_id,hidden) VALUES('foreign-child','space','user','folder','old','old','folder',NULL,1,?1,?1,?1,'foreign-trash',0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO shares(id,owner_id,root_node_id,version,actions_json,created_at) VALUES('share','user','folder',1,'[\"read\"]',?1)",
      ).bind(now),
      env.DB.prepare("UPDATE users SET used_bytes=4,physical_bytes=4 WHERE id='user'"),
    ]);
    await seedOperation("trash-operation", "trash-permit", "node.trash", 7);
    const members = await trashNode(env, {
      ...context("trash-operation", "trash-permit"),
      trashOpId: "trash-folder",
      nodeId: "folder",
      parentId: "root",
      expectedNodeRevision: 1,
      expectedParentRevision: 1,
      expectedTreeGeneration: 1,
      purgeAfter: now + 1000,
    });
    expect(members).toBe(2);
    const membership = await env.DB.prepare(
      "SELECT node_id FROM trash_members WHERE trash_op_id='trash-folder' ORDER BY node_id",
    ).all();
    expect(membership.results).toEqual([{ node_id: "file" }, { node_id: "folder" }]);
    const share = await env.DB.prepare("SELECT disabled_at FROM shares WHERE id='share'").first<{
      disabled_at: number | null;
    }>();
    expect(share?.disabled_at).not.toBeNull();

    await env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('collision','space','user','root','Docs','docs','folder',NULL,1,?1,?1,0)",
    )
      .bind(now)
      .run();
    await seedOperation("restore-operation", "restore-permit", "node.restore", 7);
    const restored = await restoreTrash(env, {
      ...context("restore-operation", "restore-permit"),
      trashOpId: "trash-folder",
      destinationParentId: "root",
      expectedDestinationRevision: 2,
      expectedTreeGeneration: 2,
    });
    expect(restored).toBe("folder");
    const nodes = await env.DB.prepare(
      "SELECT id,name,deleted_at FROM nodes WHERE id IN ('folder','file','foreign-child') ORDER BY id",
    ).all();
    expect(nodes.results).toEqual([
      { id: "file", name: "file.txt", deleted_at: null },
      { id: "folder", name: "Docs (restored 1)", deleted_at: null },
      { id: "foreign-child", name: "old", deleted_at: now },
    ]);
    const op = await env.DB.prepare(
      "SELECT state FROM trash_ops WHERE op_id='trash-folder'",
    ).first<{
      state: string;
    }>();
    expect(op?.state).toBe("restored");
  });

  it("purges in FK-safe order and reconciles a lost R2 delete response", async () => {
    const now = Date.now();
    await env.BLOBS.put("u/user/b/blob", "data");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',4,'\"b-blob\"',1,'committed',?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('file','space','user','root','file','file','file','blob',1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare("UPDATE users SET used_bytes=4,physical_bytes=4 WHERE id='user'"),
    ]);
    await seedOperation("trash-operation", "trash-permit", "node.trash", 7);
    await trashNode(env, {
      ...context("trash-operation", "trash-permit"),
      trashOpId: "trash-file",
      nodeId: "file",
      parentId: "root",
      expectedNodeRevision: 1,
      expectedParentRevision: 1,
      expectedTreeGeneration: 1,
      purgeAfter: 0,
    });
    await seedOperation("purge-operation", "purge-permit", "node.purge", 9);
    await purgeTrash(env, {
      ...context("purge-operation", "purge-permit"),
      trashOpId: "trash-file",
      expectedParentRevision: 2,
      expectedTreeGeneration: 2,
      gcNotBefore: 0,
    });
    const beforeGc = await env.DB.prepare(
      "SELECT b.state,b.ref_count,u.used_bytes,u.physical_bytes,g.state gc_state FROM blobs b JOIN users u ON u.id=b.owner_id JOIN gc_candidates g ON g.blob_id=b.id WHERE b.id='blob'",
    ).first();
    expect(beforeGc).toEqual({
      state: "gc_candidate",
      ref_count: 0,
      used_bytes: 0,
      physical_bytes: 4,
      gc_state: "candidate",
    });
    await runGarbageCollection(env, {
      now,
      token: "gc-claim",
      io: {
        async delete(key) {
          await env.BLOBS.delete(key);
          throw new Error("response lost");
        },
        head: (key) => env.BLOBS.head(key),
      },
    });
    const afterGc = await env.DB.prepare(
      "SELECT b.state,u.physical_bytes,g.state gc_state FROM blobs b JOIN users u ON u.id=b.owner_id JOIN gc_candidates g ON g.blob_id=b.id WHERE b.id='blob'",
    ).first();
    expect(afterGc).toEqual({ state: "deleted", physical_bytes: 0, gc_state: "deleted" });
  });

  it("honors multiple pins and rejects references after the deleting fence", async () => {
    const now = Date.now();
    await env.BLOBS.put("u/user/b/pinned", "data");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('pinned','user','u/user/b/pinned',4,'etag',0,'gc_candidate',?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES('pinned','candidate',0)",
      ),
      env.DB.prepare("UPDATE users SET physical_bytes=4 WHERE id='user'"),
    ]);
    await pinBlob(env, "pin-1", "pinned", "test", null);
    await pinBlob(env, "pin-2", "pinned", "test", null);
    expect(await runGarbageCollection(env, { now })).toBe(0);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM blob_pins WHERE blob_id='pinned'"),
      env.DB.prepare("UPDATE blobs SET ref_count=0 WHERE id='pinned'"),
    ]);
    await runGarbageCollection(env, {
      now,
      io: {
        async delete(key) {
          await expect(pinBlob(env, "late-pin", "pinned", "late", null)).rejects.toThrow();
          await env.BLOBS.delete(key);
        },
        head: (key) => env.BLOBS.head(key),
      },
    });
    const blob = await env.DB.prepare("SELECT state FROM blobs WHERE id='pinned'").first<{
      state: string;
    }>();
    expect(blob?.state).toBe("deleted");
  });
});
