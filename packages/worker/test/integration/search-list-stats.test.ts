import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { upsertSearchStatements } from "../../src/search/sync.js";
import { createFolder } from "../../src/services/fsMutation.js";
import { listChildren } from "../../src/services/listing.js";
import { moveNode } from "../../src/services/fileMutations.js";
import { searchNodes } from "../../src/services/search.js";
import { getAccountStats, listRecent, listStarred, setStar } from "../../src/services/stats.js";
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
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at) VALUES(?1,'user','user','as:session','space',?2,'claimed',?3,1,?4,?5,?5,?6,?7,?7)",
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

describe("list, search and stats", () => {
  it("signs keyset cursors and rejects tampering or tree generation drift", async () => {
    const now = Date.now();
    const entries: [string, string][] = [
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Charlie"],
    ];
    for (const [id, name] of entries) {
      await env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES(?1,'space','user','root',?2,?3,'folder',NULL,1,?4,?4,0)",
      )
        .bind(id, name, name.toLowerCase(), now)
        .run();
    }
    const first = await listChildren(env, "user", "root", undefined, 2);
    expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listChildren(env, "user", "root", first.nextCursor ?? undefined, 2);
    expect(second.items.map((item) => item.id)).toEqual(["c"]);
    const cursor = first.nextCursor ?? "";
    await expect(listChildren(env, "user", "root", `${cursor.slice(0, -1)}x`, 2)).rejects.toThrow(
      "Cursor is invalid",
    );
    await env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space'",
    ).run();
    await expect(listChildren(env, "user", "root", cursor, 2)).rejects.toThrow(
      "Cursor does not match",
    );
  });

  it("keeps external FTS synchronized with create and rename mutations", async () => {
    await seedOperation("create", "create-permit", "node.create", 5);
    await createFolder(env, {
      ...context("create", "create-permit"),
      nodeId: "catalog",
      parentId: "root",
      name: "Catalog",
      expectedParentRevision: 1,
      expectedTreeGeneration: 1,
    });
    const created = await searchNodes(env, "user", "root", "tal");
    expect(created.items.map((item) => item.id)).toEqual(["catalog"]);

    await seedOperation("rename", "rename-permit", "node.rename", 5);
    await moveNode(env, {
      ...context("rename", "rename-permit"),
      nodeId: "catalog",
      sourceParentId: "root",
      destinationParentId: "root",
      name: "Archive",
      expectedNodeRevision: 1,
      expectedSourceParentRevision: 2,
      expectedTreeGeneration: 2,
    });
    expect((await searchNodes(env, "user", "root", "catalog")).items).toEqual([]);
    expect((await searchNodes(env, "user", "root", "chiv")).items.map((item) => item.id)).toEqual([
      "catalog",
    ]);
  });

  it("supports kana substring and bounded one-character scope while excluding stale rows", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('scope','space','user','root','Scope','scope','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('kana','space','user','scope','カタログ','カタログ','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      ...upsertSearchStatements(env, {
        nodeId: "scope",
        spaceId: "space",
        text: "Scope",
        revision: 1,
      }),
      ...upsertSearchStatements(env, {
        nodeId: "kana",
        spaceId: "space",
        text: "カタログ",
        revision: 1,
      }),
    ]);
    expect((await searchNodes(env, "user", "scope", "かた")).items.map((item) => item.id)).toEqual([
      "kana",
    ]);
    expect((await searchNodes(env, "user", "scope", "タロ")).items.map((item) => item.id)).toEqual([
      "kana",
    ]);
    expect((await searchNodes(env, "user", "scope", "ロ")).items.map((item) => item.id)).toEqual([
      "kana",
    ]);
    await env.DB.prepare("UPDATE nodes SET revision=2 WHERE id='kana'").run();
    expect((await searchNodes(env, "user", "scope", "かた")).items).toEqual([]);
  });

  it("computes bounded capacity stats and current-scope recent/starred lists", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',8,'etag',1,'committed',?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('folder','space','user','root','Folder','folder','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('file','space','user','folder','File','file','file','blob',1,?1,?2,0)",
      ).bind(now, now + 1),
      env.DB.prepare("UPDATE users SET used_bytes=8,physical_bytes=8 WHERE id='user'"),
    ]);
    const stats = await getAccountStats(env, "user");
    expect(stats).toMatchObject({
      files: 1,
      folders: 1,
      logicalBytes: 8,
      usedBytes: 8,
      truncated: false,
    });
    expect((await listRecent(env, "user"))[0]?.id).toBe("file");
    await setStar(env, "user", "session", "file", true);
    expect((await listStarred(env, "user")).map((item) => item.id)).toEqual(["file"]);
    await env.DB.prepare("UPDATE nodes SET deleted_at=?1 WHERE id='folder'").bind(now).run();
    expect(await listStarred(env, "user")).toEqual([]);
  });
});
