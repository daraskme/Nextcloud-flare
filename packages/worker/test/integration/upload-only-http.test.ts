import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { updateLinkShare } from "../../src/services/linkShares";
import { uploadRow } from "../../src/services/uploads/access";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

const cleanup: string[] = [];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
});
afterEach(async () => {
  if (cleanup.length) await env.BLOBS.delete(cleanup.splice(0));
});
async function fixture() {
  const t = await publicShareFixture("upload_only");
  const deps = {
    ...t.deps,
    uploads: new UploadCapabilities(await contentKeyRing("test", { test: t.key })),
  };
  const http = (request: Request) => handlePublicShareHttp(request, t.app, 1, deps);
  const create = (name = "File", mode = "single", key = crypto.randomUUID()) =>
    http(t.request("/uploads", "POST", { name, mode, declared_size: 3 }, t.token, key));
  const accepted = async (name = "File", mode = "single", key = crypto.randomUUID()) => {
    const response = await create(name, mode, key);
    expect(response.status).toBe(201);
    const receipt = await response.json<{ receipt_id: string; status_url: string }>();
    expect(Object.keys(receipt).sort()).toEqual(["receipt_id", "status_url"]);
    const cap = response.headers.get("Upload-Capability")!;
    expect(cap).toBeTruthy();
    const row = (await uploadRow(env.DB, receipt.receipt_id))!;
    cleanup.push(`u/${row.owner_id}/b/${row.blob_id}`);
    const request = (action = "", method = "GET", body?: unknown, key = crypto.randomUUID()) => {
      const r = t.request(`/uploads/${receipt.receipt_id}${action}`, method, body, t.token, key);
      r.headers.set("Upload-Capability", cap);
      return r;
    };
    const write = async () => {
      const r = request(mode === "single" ? "/content" : "/parts/1", "PUT");
      r.headers.delete("Content-Type");
      r.headers.set("Content-Length", "3");
      r.headers.set("Upload-Attempt-Id", "first");
      const response = await http(new Request(r, { body: "abc" }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(receipt);
    };
    return {
      receipt,
      cap,
      row,
      request,
      write,
      status: () => http(request()),
      complete: (key = crypto.randomUUID()) => http(request("/complete", "POST", {}, key)),
    };
  };
  return { ...t, deps, http, create, accepted };
}
it.each(["single", "multipart"])(
  "accepts %s with the same opaque receipt for new names and collisions",
  async (mode) => {
    const t = await fixture();
    for (const name of ["received.txt", "File", "FILE", "received.txt"]) {
      const r = await t.accepted(name, mode);
      expect(r.row).toMatchObject({ upload_only: 1, target_id: null, link_share_id: t.share.id });
      expect(
        await env.DB.prepare("SELECT share_id FROM reservations WHERE id=?")
          .bind(r.row.reservation_id)
          .first("share_id"),
      ).toBe(t.share.id);
      await r.write();
      const key = crypto.randomUUID(),
        complete = await r.complete(key);
      expect(complete.status).toBe(201);
      expect(complete.headers.get("Operation-Id")).toBeNull();
      expect(await complete.json()).toEqual(r.receipt);
      expect(await (await r.complete(key)).json()).toEqual(r.receipt);
      const status = await (await r.status()).json<Record<string, unknown>>();
      expect(status).toMatchObject({ state: "completed", operationId: null, errorCode: null });
      expect(status).not.toHaveProperty("name");
      expect(status).not.toHaveProperty("nodeId");
      expect(status).not.toHaveProperty("blobId");
      const node = await env.DB.prepare(
        "SELECT id,name,name_ci,current_blob_id FROM nodes WHERE current_blob_id=?",
      )
        .bind(r.row.blob_id)
        .first<{ id: string; name: string; name_ci: string; current_blob_id: string }>();
      expect(node).not.toBeNull();
      if (name === "File" || name === "FILE") expect(node!.name).not.toBe(name);
      const search = searchName(node!.name);
      expect(
        await env.DB.prepare("SELECT text_norm,tokens FROM search_index WHERE node_id=?")
          .bind(node!.id)
          .first(),
      ).toEqual({ text_norm: search.textNorm, tokens: search.tokens });
      expect(await (await env.BLOBS.get(`u/${r.row.owner_id}/b/${r.row.blob_id}`))!.text()).toBe(
        "abc",
      );
    }
    expect(
      await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
        .bind(t.f.ids.file)
        .first("current_blob_id"),
    ).toBe(t.f.ids.blob);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
        .bind(t.share.id)
        .first("reserved_bytes"),
    ).toBe(0);
  },
);
it("hides namespace metadata and rejects read, create-folder, overwrite, delete and operation lookup", async () => {
  const t = await fixture();
  const info = await (await t.http(t.request(""))).json<Record<string, unknown>>();
  expect(info).toMatchObject({
    kind: "upload_only",
    permissions: {
      upload: true,
      overwrite: false,
      createFolder: false,
      rename: false,
      delete: false,
    },
  });
  for (const key of ["root", "rootNodeId", "ownerId", "spaceId", "contentOrigin"])
    expect(info).not.toHaveProperty(key);
  for (const [suffix, method, body] of [
    [`/children/${t.f.ids.folder}`, "GET", undefined],
    ["/content-session", "POST", { nodeIds: [t.f.ids.file], ttlSeconds: 300 }],
    [`/content/${t.f.ids.file}`, "GET", undefined],
    ["/nodes", "POST", { name: "new", parentId: t.f.ids.folder, kind: "folder" }],
    [`/nodes/${t.f.ids.file}`, "PATCH", { name: "changed" }],
    [`/nodes/${t.f.ids.file}`, "DELETE", undefined],
    ["/api/v1/operations/op_" + "a".repeat(64), "GET", undefined],
  ] as const)
    expect((await t.http(t.request(suffix, method, body, t.token))).status, suffix).toBe(404);
  for (const extra of [
    { parentId: t.f.ids.folder },
    { targetId: t.f.ids.file, targetRevision: 1 },
    { spaceId: t.f.ids.space },
  ]) {
    expect(
      (
        await t.http(
          t.request(
            "/uploads",
            "POST",
            { name: "File", mode: "single", declared_size: 3, ...extra },
            t.token,
          ),
        )
      ).status,
    ).toBe(400);
  }
  for (const intent of [
    { operation: "node.read" as const, nodeId: t.f.ids.file },
    { operation: "node.create" as const, parentId: t.f.ids.folder },
    { operation: "node.create" as const, parentId: t.f.ids.root, upload: true },
    { operation: "node.content.write" as const, nodeId: t.f.ids.file, upload: true },
  ])
    await expect(
      authorizeNode(env.DB, publicPrincipal(t.session), { ...intent, spaceId: t.f.ids.space }),
    ).rejects.toThrow("authorization_denied");
});
it("enforces share quota atomically, replays the original receipt and releases only its own untouched upload", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE shares SET reservation_limit=4 WHERE id=?").bind(t.share.id).run();
  const key = crypto.randomUUID(),
    r = await t.accepted("File", "single", key);
  const replay = await t.create("File", "single", key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(r.receipt);
  expect(replay.headers.get("Upload-Capability")).toBe(r.cap);
  expect((await t.create("other")).status).toBe(507);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(t.f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(3);
  const cancelled = await t.http(r.request("", "DELETE", {}));
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ state: "aborted", operationId: null });
  expect((await t.create("other")).status).toBe(201);
});
it("enforces owner quota before accepting a share reservation", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=5 WHERE id=?").bind(t.f.ids.user).run();
  expect((await t.create()).status).toBe(507);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE owner_id=?")
      .bind(t.f.ids.user)
      .first("n"),
  ).toBe(0);
});
it("binds the saved upload to its original session and retains reservations after revocation", async () => {
  const t = await fixture(),
    r = await t.accepted();
  const absent = r.request();
  absent.headers.delete("Cookie");
  expect((await t.http(absent)).status).toBe(401);
  const wrong = r.request();
  wrong.headers.set("Share-Session", "another");
  expect((await t.http(wrong)).status).toBe(412);
  const cap = r.request();
  cap.headers.delete("Upload-Capability");
  expect((await t.http(cap)).status).toBe(403);
  await expect(
    env.DB.prepare("UPDATE uploads SET upload_only=0 WHERE id=?").bind(r.receipt.receipt_id).run(),
  ).rejects.toThrow("immutable_upload_policy");
  await updateLinkShare(t.app, t.owner, t.share.id, 1, null);
  expect((await r.status()).status).toBe(401);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(3);
});

it("serializes same-name publication and atomically chooses a new name when a collision appears before commit", async () => {
  const t = await fixture();
  const first = await t.accepted("simultaneous.txt"),
    second = await t.accepted("simultaneous.txt");
  await first.write();
  await second.write();
  const firstKey = crypto.randomUUID(),
    secondKey = crypto.randomUUID();
  const results = await Promise.all([first.complete(firstKey), second.complete(secondKey)]);
  for (const [i, upload] of [first, second].entries()) {
    // A conflicting namespace permit can be rejected before dispatch; the original key remains reusable.
    if (results[i]!.status !== 201)
      expect((await upload.complete(i ? secondKey : firstKey)).status).toBe(201);
    expect(await (await upload.status()).json()).toMatchObject({
      state: "completed",
      operationId: null,
    });
  }
  const nodes = await env.DB.prepare("SELECT name_ci FROM nodes WHERE current_blob_id IN (?,?)")
    .bind(first.row.blob_id, second.row.blob_id)
    .all<{ name_ci: string }>();
  expect(nodes.results).toHaveLength(2);
  expect(new Set(nodes.results.map((n) => n.name_ci)).size).toBe(2);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(0);
});

it.each(["single", "multipart"])(
  "settles a proven failed %s publication without exposing a private operation",
  async (mode) => {
    const t = await fixture(),
      r = await t.accepted("failed.txt", mode);
    await r.write();
    t.app.DB = injectBatch(
      (sql) => sql.includes("SET state='consumed'"),
      async () => {
        await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
          .bind(t.f.ids.folder)
          .run();
      },
      false,
    );
    const response = await r.complete();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(r.receipt);
    expect(await (await r.status()).json()).toMatchObject({
      state: "failed",
      operationId: null,
      errorCode: "upload_failed",
    });
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
        .bind(t.share.id)
        .first("reserved_bytes"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(t.f.ids.user)
        .first("reserved_bytes"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(r.row.blob_id).first("state"),
    ).toBe("orphan");
    expect(await env.BLOBS.head(`u/${r.row.owner_id}/b/${r.row.blob_id}`)).not.toBeNull();
  },
);
it("holds both reservations until a cancelled multipart handle is proven closed", async () => {
  const t = await fixture(),
    r = await t.accepted("cancel.bin", "multipart");
  await r.write();
  expect((await t.http(r.request("", "DELETE", {}))).status).toBe(202);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(3);
  const errors: unknown[] = [];
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      try {
        return await env.DB.batch(statements);
      } catch (e) {
        errors.push(e);
        throw e;
      }
    },
  } as D1Database;
  await repairMultipartUploads(mutationEnv(db), env.BLOBS, 1);
  expect(errors).toEqual([]);
  expect((await uploadRow(env.DB, r.row.id))?.state).toBe("aborted");
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(t.share.id)
      .first("reserved_bytes"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(t.f.ids.user)
      .first("reserved_bytes"),
  ).toBe(0);
});
