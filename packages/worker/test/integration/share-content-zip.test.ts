import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import { app } from "../../src/index.js";
import { authenticateShare, unlockShare } from "../../src/auth/share.js";
import {
  acceptContentTicket,
  createUserContentTicket,
  serveContentSession,
} from "../../src/services/contentSessions.js";
import { abortShareUpload, createShareUpload } from "../../src/services/shareUploads.js";
import { createShare, disableShare, listShareChildren } from "../../src/services/shares.js";
import { createUserZip, serveUserZip } from "../../src/services/zip.js";
import { seedFoundation } from "../helpers/foundation.js";

const user: AuthenticatedUser = {
  email: "user@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "user",
    userId: "user",
    sessionId: "session",
    credentialId: "as:session",
    scopes: [],
  },
};

const zipUser: AuthenticatedUser = {
  email: "zip@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "zip_user",
    userId: "zip_user",
    sessionId: "zip_session",
    credentialId: "as:zip_session",
    scopes: [],
  },
};

async function seedFiles(): Promise<void> {
  const now = Date.now();
  const bytes = new TextEncoder().encode("hello share");
  await env.BLOBS.put("u/user/b/blob", bytes);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,client_sha256,content_etag,r2_etag,mime_sniffed,ref_count,state,created_at,last_op_id) VALUES('blob','user','u/user/b/blob',?1,NULL,NULL,'\"b-blob\"','r2','text/plain',1,'committed',?2,NULL)",
    ).bind(bytes.byteLength, now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('folder','space','user','root','Shared','shared','folder',NULL,1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('file','space','user','folder','hello.txt','hello.txt','file','blob',1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
  ]);
}

async function seedZipFiles(): Promise<void> {
  const now = Date.now();
  const bytes = new TextEncoder().encode("zip content");
  await env.BLOBS.put("u/zip_user/b/zip_blob", bytes);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,used_bytes,physical_bytes,reserved_bytes,disabled_at,created_at) VALUES('zip_user','iss','zip','zip@test.invalid','member',1000000,?1,?1,0,NULL,?2)",
    ).bind(bytes.byteLength, now),
    env.DB.prepare(
      "INSERT INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES('zip_space','zip_user','zip_root',1)",
    ),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('zip_root','zip_space','zip_user',NULL,'','', 'root',NULL,1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('zip_folder','zip_space','zip_user','zip_root','Archive','archive','folder',NULL,1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,client_sha256,content_etag,r2_etag,mime_sniffed,ref_count,state,created_at,last_op_id) VALUES('zip_blob','zip_user','u/zip_user/b/zip_blob',?1,NULL,NULL,'\"b-zip_blob\"','r2','text/plain',1,'committed',?2,NULL)",
    ).bind(bytes.byteLength, now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES('zip_file','zip_space','zip_user','zip_folder','inside.txt','inside.txt','file','zip_blob',1,NULL,?1,?1,NULL,NULL,NULL,0,NULL)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES('zip_session','zip_user','access','zip-fingerprint',?1,?2,NULL,?1)",
    ).bind(now, now + 86_400_000),
  ]);
}

function linkSecret(publicUrl: string | undefined): string {
  if (publicUrl === undefined) throw new Error("link missing");
  return publicUrl.slice(publicUrl.indexOf("#") + 1);
}

beforeEach(async () => {
  await seedFoundation();
  await seedFiles();
});

describe("Phase 6 share capability", () => {
  it("unlocks a password link through the anonymous HTTP route and revokes it", async () => {
    const created = await createShare(env, user, {
      rootNodeId: "folder",
      kind: "link",
      mode: "download",
      password: "correct horse",
    });
    const unlock = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${created.id}/unlock`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.test.invalid",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ secret: linkSecret(created.publicUrl), password: "correct horse" }),
      },
      env,
    );
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^__Host-ncf_share_/u);
    const publicShare = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${created.id}`,
      { headers: { Cookie: cookie ?? "" } },
      env,
    );
    expect(publicShare.status).toBe(200);
    await expect(publicShare.json()).resolves.toMatchObject({ mode: "download" });

    const authentication = await authenticateShare(
      env,
      new Request("https://app.test.invalid", { headers: { Cookie: cookie ?? "" } }),
      created.id,
    );
    await expect(listShareChildren(env, authentication.share, "folder")).resolves.toHaveLength(1);
    await disableShare(env, user, created.id);
    await expect(
      authenticateShare(
        env,
        new Request("https://app.test.invalid", { headers: { Cookie: cookie ?? "" } }),
        created.id,
      ),
    ).rejects.toThrow("share_gone");
  });

  it("invalidates a share as soon as its root has a deleted ancestor", async () => {
    const created = await createShare(env, user, {
      rootNodeId: "file",
      kind: "link",
      mode: "download",
    });
    await env.DB.prepare("UPDATE nodes SET deleted_at=?1 WHERE id='folder'").bind(Date.now()).run();
    await expect(
      unlockShare(
        env,
        new Request("https://app.test.invalid"),
        created.id,
        linkSecret(created.publicUrl),
      ),
    ).rejects.toThrow("share_not_found");
  });

  it("returns indistinguishable upload-only receipts after automatic collision handling", async () => {
    const created = await createShare(env, user, {
      rootNodeId: "folder",
      kind: "link",
      mode: "upload",
    });
    const unlocked = await unlockShare(
      env,
      new Request("https://app.test.invalid"),
      created.id,
      linkSecret(created.publicUrl),
    );
    const first = await createShareUpload(env, unlocked.authentication, {
      name: "hello.txt",
      declaredSize: 1,
      mode: "single",
    });
    const second = await createShareUpload(env, unlocked.authentication, {
      name: "hello.txt",
      declaredSize: 1,
      mode: "single",
    });
    expect(Object.keys(first).sort()).toEqual(["receipt_id", "status_url"]);
    expect(Object.keys(second).sort()).toEqual(["receipt_id", "status_url"]);
    expect(first).not.toHaveProperty("name");
    await abortShareUpload(env, unlocked.authentication, first.receipt_id);
    await abortShareUpload(env, unlocked.authentication, second.receipt_id);
  });
});

describe("Phase 6 content session", () => {
  it("binds purpose and reuses the user budget id across tickets", async () => {
    const first = await createUserContentTicket(env, user, "content", ["file"]);
    const second = await createUserContentTicket(env, user, "content", ["file"]);
    const budgets = await env.DB.prepare(
      "SELECT COUNT(DISTINCT budget_id) count,MIN(budget_id) budgetId FROM content_tickets",
    ).first<{ count: number; budgetId: string }>();
    expect(budgets).toEqual({ count: 1, budgetId: "u:user" });

    const accepted = await acceptContentTicket(env, first.ticket);
    const cookie = accepted.cookie.split(";", 1)[0] ?? "";
    const response = await serveContentSession(
      env,
      new Request("https://content.test.invalid/c/file/blob", { headers: { Cookie: cookie } }),
      "file",
      "blob",
      "content",
    );
    expect(await response.text()).toBe("hello share");
    await expect(
      serveContentSession(
        env,
        new Request("https://content.test.invalid/c/file/blob", { headers: { Cookie: cookie } }),
        "file",
        "blob",
        "thumb",
      ),
    ).rejects.toThrow("content_target_forbidden");
    expect(second.ticket).not.toBe(first.ticket);
  });
});

describe("Phase 6 STORE ZIP", () => {
  it("stores exact output size, holds pins, and releases them after delivery", async () => {
    await seedZipFiles();
    const manifest = await createUserZip(env, zipUser, "zip_folder");
    const pinned = await env.DB.prepare(
      "SELECT COUNT(*) count FROM blob_pins WHERE purpose='zip'",
    ).first<{ count: number }>();
    expect(pinned?.count).toBe(1);
    const response = await serveUserZip(env, zipUser, manifest.id);
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBe(manifest.size);
    expect(Array.from(new Uint8Array(bytes).slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) count FROM blob_pins WHERE purpose='zip'",
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });
});
