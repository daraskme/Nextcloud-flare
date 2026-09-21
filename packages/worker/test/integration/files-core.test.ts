import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { transferImmutableBlob } from "../../src/services/blobs.js";
import { serveNodeContent } from "../../src/services/content.js";
import { buildCopyManifest, commitSameOwnerCopy } from "../../src/services/copy.js";
import { createFile, moveNode, overwriteFile } from "../../src/services/fileMutations.js";
import { reserveQuota } from "../../src/services/quota.js";
import { listVersions, restoreFileVersion } from "../../src/services/versions.js";
import { seedFoundation } from "../helpers/foundation.js";

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

async function seedOperation(
  operationId: string,
  permitId: string,
  kind: string,
  expectedSteps: number,
  spaceId = "space",
): Promise<void> {
  const now = Date.now();
  const expires = now + 30_000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?1,?2,1,?3,'open')",
    ).bind(permitId, spaceId, expires),
    env.DB.prepare(
      "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,error_code,created_at,updated_at) VALUES(?1,'user','user','as:session',NULL,?2,?3,'claimed',?4,1,?5,?6,?6,?7,NULL,NULL,?8,?8)",
    ).bind(
      operationId,
      spaceId,
      kind,
      `digest-${operationId}`,
      permitId,
      expires,
      expectedSteps,
      now,
    ),
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

describe("Files core", () => {
  it("keeps concurrent same-name creates atomic after immutable R2 transfer", async () => {
    await reserveQuota(env, "user", 4);
    await reserveQuota(env, "user", 4);
    await transferImmutableBlob(env, {
      ownerId: "user",
      blobId: "blob-a",
      source: stream("aaaa"),
      size: 4,
    });
    await transferImmutableBlob(env, {
      ownerId: "user",
      blobId: "blob-b",
      source: stream("bbbb"),
      size: 4,
    });
    await seedOperation("op-a", "permit-a", "node.create", 7);
    await seedOperation("op-b", "permit-b", "node.create", 7);
    const base = {
      parentId: "root",
      expectedParentRevision: 1,
      name: "same.txt",
      expectedTreeGeneration: 1,
    };
    const results = await Promise.allSettled([
      createFile(env, {
        ...context("op-a", "permit-a"),
        ...base,
        nodeId: "file-a",
        blobId: "blob-a",
      }),
      createFile(env, {
        ...context("op-b", "permit-b"),
        ...base,
        nodeId: "file-b",
        blobId: "blob-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const nodes = await env.DB.prepare(
      "SELECT id,current_blob_id FROM nodes WHERE parent_id='root' AND name_ci='same.txt'",
    ).all();
    expect(nodes.results).toHaveLength(1);
    const user = await env.DB.prepare(
      "SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id='user'",
    ).first<{ used_bytes: number; reserved_bytes: number; physical_bytes: number }>();
    expect(user).toEqual({ used_bytes: 4, reserved_bytes: 4, physical_bytes: 8 });
  });

  it("versions overwrite atomically and keeps old and current blob references", async () => {
    await env.BLOBS.put("u/user/b/old", "old!!");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,r2_etag,mime_sniffed,ref_count,state,created_at) VALUES('old','user','u/user/b/old',5,'\"b-old\"','r2-old','text/plain',1,'committed',?1)",
      ).bind(Date.now()),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('file','space','user','root','file.txt','file.txt','file','old',1,?1,?1,0)",
      ).bind(Date.now()),
      env.DB.prepare("UPDATE users SET used_bytes=5,physical_bytes=5 WHERE id='user'"),
    ]);
    await reserveQuota(env, "user", 4);
    await transferImmutableBlob(env, {
      ownerId: "user",
      blobId: "new",
      source: stream("new!"),
      size: 4,
    });
    await seedOperation("overwrite", "permit-overwrite", "node.content.write", 7);
    await overwriteFile(env, {
      ...context("overwrite", "permit-overwrite"),
      nodeId: "file",
      parentId: "root",
      blobId: "new",
      versionId: "version-old",
      expectedNodeRevision: 1,
      expectedParentRevision: 1,
    });
    const node = await env.DB.prepare(
      "SELECT current_blob_id,revision FROM nodes WHERE id='file'",
    ).first<{ current_blob_id: string; revision: number }>();
    const version = await env.DB.prepare(
      "SELECT blob_id FROM node_versions WHERE id='version-old'",
    ).first<{ blob_id: string }>();
    const refs = await env.DB.prepare("SELECT id,ref_count,state FROM blobs ORDER BY id").all<{
      id: string;
      ref_count: number;
      state: string;
    }>();
    const user = await env.DB.prepare(
      "SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id='user'",
    ).first();
    expect(node).toEqual({ current_blob_id: "new", revision: 2 });
    expect(version?.blob_id).toBe("old");
    expect(refs.results).toEqual([
      { id: "new", ref_count: 1, state: "committed" },
      { id: "old", ref_count: 1, state: "committed" },
    ]);
    expect(user).toEqual({ used_bytes: 9, reserved_bytes: 0, physical_bytes: 9 });
    const versions = await listVersions(env, "user", "file");
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      id: null,
      blobId: "new",
      size: 4,
      current: true,
    });
    expect(versions[1]).toMatchObject({
      id: "version-old",
      blobId: "old",
      size: 5,
      current: false,
    });
    expect(versions.every((entry) => Number.isSafeInteger(entry.createdAt))).toBe(true);

    await seedOperation("restore-version", "permit-restore-version", "node.content.write", 6);
    await restoreFileVersion(env, {
      ...context("restore-version", "permit-restore-version"),
      nodeId: "file",
      parentId: "root",
      versionId: "version-old",
      replacementVersionId: "version-new",
      expectedNodeRevision: 2,
      expectedParentRevision: 2,
    });
    const restored = await env.DB.prepare(
      "SELECT current_blob_id,revision FROM nodes WHERE id='file'",
    ).first();
    const restoredRefs = await env.DB.prepare(
      "SELECT id,ref_count FROM blobs WHERE id IN ('new','old') ORDER BY id",
    ).all();
    expect(restored).toEqual({ current_blob_id: "old", revision: 3 });
    expect(restoredRefs.results).toEqual([
      { id: "new", ref_count: 1 },
      { id: "old", ref_count: 2 },
    ]);
  });

  it("serves HEAD, strong validators and a single Range only after EffectiveLive", async () => {
    await env.BLOBS.put("u/user/b/content", "0123456789");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,r2_etag,mime_sniffed,ref_count,state,created_at) VALUES('content','user','u/user/b/content',10,'\"b-content\"','r2','text/plain',1,'committed',?1)",
      ).bind(Date.now()),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('file','space','user','root','data.txt','data.txt','file','content',1,?1,?1,0)",
      ).bind(Date.now()),
    ]);
    const head = await serveNodeContent(
      env,
      "user",
      "file",
      new Request("https://app.test/file", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("etag")).toBe('"b-content"');

    const partial = await serveNodeContent(
      env,
      "user",
      "file",
      new Request("https://app.test/file", { headers: { Range: "bytes=2-5" } }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const unchanged = await serveNodeContent(
      env,
      "user",
      "file",
      new Request("https://app.test/file", { headers: { "If-None-Match": '"b-content"' } }),
    );
    expect(unchanged.status).toBe(304);

    expect(partial.headers.get("content-disposition")).toMatch(/^inline; /u);
    const attachment = await serveNodeContent(
      env,
      "user",
      "file",
      new Request("https://app.test/file?download=1"),
    );
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-disposition")).toMatch(/^attachment; /u);
    await env.DB.prepare("UPDATE nodes SET deleted_at=?1 WHERE id='file'").bind(Date.now()).run();
    await expect(
      serveNodeContent(env, "user", "file", new Request("https://app.test/file")),
    ).rejects.toThrow("node_not_found");
  });

  it("prevents mutual MOVE cycles and rejects cross-space destinations", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('a','space','user','root','A','a','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('b','space','user','root','B','b','folder',NULL,1,?1,?1,0)",
      ).bind(now),
    ]);
    await seedOperation("move-a", "permit-move-a", "node.move", 6);
    await seedOperation("move-b", "permit-move-b", "node.move", 6);
    const results = await Promise.allSettled([
      moveNode(env, {
        ...context("move-a", "permit-move-a"),
        expectedTreeGeneration: 1,
        nodeId: "a",
        sourceParentId: "root",
        destinationParentId: "b",
        name: "A",
        expectedNodeRevision: 1,
        expectedSourceParentRevision: 1,
        expectedDestinationParentRevision: 1,
      }),
      moveNode(env, {
        ...context("move-b", "permit-move-b"),
        expectedTreeGeneration: 1,
        nodeId: "b",
        sourceParentId: "root",
        destinationParentId: "a",
        name: "B",
        expectedNodeRevision: 1,
        expectedSourceParentRevision: 1,
        expectedDestinationParentRevision: 1,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const tree = await env.DB.prepare(
      "SELECT id,parent_id FROM nodes WHERE id IN ('a','b') ORDER BY id",
    ).all();
    expect(tree.results.filter((row) => row.parent_id === "root")).toHaveLength(1);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES('other','iss','other','other@test.invalid','member',1000,?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES('other-space','other','other-root',1)",
      ),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('other-root','other-space','other',NULL,'','', 'root',NULL,1,?1,?1,0)",
      ).bind(now),
    ]);
    const rootChild = tree.results.find((row) => row.parent_id === "root");
    expect(rootChild).toBeDefined();
    await seedOperation("cross", "permit-cross", "node.move", 6);
    await expect(
      moveNode(env, {
        ...context("cross", "permit-cross"),
        expectedTreeGeneration: 2,
        nodeId: String(rootChild?.id),
        sourceParentId: "root",
        destinationParentId: "other-root",
        name: String(rootChild?.id),
        expectedNodeRevision: (rootChild as { revision?: number } | undefined)?.revision ?? 2,
        expectedSourceParentRevision: 2,
        expectedDestinationParentRevision: 1,
      }),
    ).rejects.toThrow();
  });

  it("copies a fixed folder manifest with dead properties and COW accounting", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',10,'\"b-blob\"',1,'committed',?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('source','space','user','root','Source','source','folder',NULL,1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('child','space','user','source','child.txt','child.txt','file','blob',1,?1,?1,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO node_props(node_id,namespace_uri,local_name,value_xml) VALUES('child','urn:test','color','blue')",
      ),
      env.DB.prepare("UPDATE users SET used_bytes=10,physical_bytes=10 WHERE id='user'"),
    ]);
    const collisionIds = ["collision-root", "collision-child"];
    const collision = await buildCopyManifest(env, {
      sourceId: "source",
      destinationParentId: "root",
      userId: "user",
      idFactory: () => collisionIds.shift() ?? "unexpected",
    });
    await seedOperation(
      "copy-collision",
      "permit-copy-collision",
      "node.copy",
      collision.entries.length + 4,
    );
    await expect(
      commitSameOwnerCopy(env, {
        ...context("copy-collision", "permit-copy-collision"),
        expectedTreeGeneration: 1,
        expectedDestinationRevision: 1,
        manifest: collision,
      }),
    ).rejects.toThrow();
    const unchanged = await env.DB.prepare("SELECT ref_count FROM blobs WHERE id='blob'").first<{
      ref_count: number;
    }>();
    expect(unchanged?.ref_count).toBe(1);

    const ids = ["copy-root", "copy-child"];
    const manifest = await buildCopyManifest(env, {
      sourceId: "source",
      destinationParentId: "root",
      userId: "user",
      name: "Source copy",
      idFactory: () => ids.shift() ?? "unexpected",
    });
    await seedOperation("copy", "permit-copy", "node.copy", manifest.entries.length + 4);
    await commitSameOwnerCopy(env, {
      ...context("copy", "permit-copy"),
      expectedTreeGeneration: 1,
      expectedDestinationRevision: 1,
      manifest,
    });
    const blob = await env.DB.prepare("SELECT ref_count FROM blobs WHERE id='blob'").first<{
      ref_count: number;
    }>();
    const property = await env.DB.prepare(
      "SELECT value_xml FROM node_props WHERE node_id='copy-child' AND namespace_uri='urn:test'",
    ).first<{ value_xml: string }>();
    const user = await env.DB.prepare("SELECT used_bytes FROM users WHERE id='user'").first<{
      used_bytes: number;
    }>();
    expect(blob?.ref_count).toBe(2);
    expect(property?.value_xml).toBe("blue");
    expect(user?.used_bytes).toBe(10);
  });

  it("rejects REST permits that overlap an active DAV lock", async () => {
    await env.DB.prepare(
      "INSERT INTO locks(id,node_id,creator_user_id,creator_credential_id,token_digest,depth,expires_at,epoch) VALUES('lock','root','user','as:session','digest','0',?1,1)",
    )
      .bind(Date.now() + 60_000)
      .run();
    const stub = env.LOCKS.get(env.LOCKS.idFromName("space"));
    const response = await stub.fetch("https://lock.test/permits", {
      method: "POST",
      body: JSON.stringify({
        permitId: "locked-permit",
        spaceId: "space",
        epoch: 1,
        ttlMs: 5000,
        nodeIds: ["root"],
      }),
    });
    expect(response.status).toBe(423);
    await expect(
      env.DB.prepare("SELECT permit_id FROM permits WHERE permit_id='locked-permit'").first(),
    ).resolves.toBeNull();
  });
});
