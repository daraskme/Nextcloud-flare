import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { accessPrincipal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import type { VisibleOperation } from "../../src/jobs/operations";
import { createFolder } from "../../src/services/createFolder";
import { createLinkShare, updateLinkShare } from "../../src/services/linkShares";
import { logoutShare, unlockShare } from "../../src/services/shareUnlock";
import { trashNode } from "../../src/services/trashNode";
import { uploadRow } from "../../src/services/uploads/access";
import { settleFailedCompletion } from "../../src/services/uploads/failedCompletion";
import { foundationFixture } from "../fixtures/foundation";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const origin = "https://app.invalid",
  cleanup: string[] = [];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
});
afterEach(async () => {
  if (cleanup.length) await env.BLOBS.delete(cleanup.splice(0));
});
interface Receipt {
  id: string;
  capability: string;
  state: string;
  partBytes?: number;
  partCount?: number;
}
async function fixture(role: "read" | "edit" = "edit", root: "file" | "folder" = "folder") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const search = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.file, f.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const app: Env = {
    ...admitted(),
    CONTROL: mutationEnv().CONTROL,
    APP_ORIGIN: origin,
    EDGE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(app, owner, { kind: "link", rootNodeId: f.ids[root], role });
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ShareTokens(ring, origin);
  const deps = {
    tokens,
    csrf: new CsrfTokens({ activeKid: "unused", keys: new Map() }, ring, origin),
    uploads: new UploadCapabilities(ring),
  };
  const session = await unlockShare(app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(session.claims)}`;
  const request = (
    suffix: string,
    method: string,
    body?: BodyInit,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${origin}/api/v1/public/shares/${share.id}${suffix}`, {
      method,
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "CF-Connecting-IP": "192.0.2.1",
        Cookie: cookie,
        "Share-Session": session.claims.session_id,
        "Content-Type": "application/json",
        "Idempotency-Key": "create",
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });
  const http = (r: Request) => handlePublicShareHttp(r, app, 1, deps);
  const { token } = await (await http(request("/csrf", "POST"))).json<{ token: string }>();
  const send = (
    suffix: string,
    method: string,
    body?: BodyInit,
    headers: Record<string, string> = {},
  ) => http(request(suffix, method, body, { "X-CSRF-Token": token, ...headers }));
  const create = (fields: Record<string, unknown> = {}, key = "create") =>
    send(
      "/uploads",
      "POST",
      JSON.stringify({
        mode: "single",
        parentId: f.ids.folder,
        name: "public.txt",
        declared_size: 3,
        ...fields,
      }),
      { "Idempotency-Key": key },
    );
  const reserve = async (fields: Record<string, unknown> = {}, key = "create") => {
    const response = await create(fields, key);
    expect(response.status).toBe(201);
    const value = await response.json<Receipt>();
    cleanup.push(`u/${f.ids.user}/b/${value.id}_blob`);
    return value;
  };
  const put = (r: Receipt, text = "abc", extra: Record<string, string> = {}, multipart = false) =>
    send(`/uploads/${r.id}/${multipart ? "parts/1" : "content"}`, "PUT", text, {
      "Upload-Capability": r.capability,
      "Content-Length": String(new TextEncoder().encode(text).length),
      "Content-Type": "application/octet-stream",
      "X-CSRF-Token": "",
      "Upload-Attempt-Id": "first",
      ...extra,
    });
  const status = (r: Receipt) =>
    send(`/uploads/${r.id}`, "GET", undefined, { "Upload-Capability": r.capability });
  const complete = (r: Receipt) =>
    send(`/uploads/${r.id}/complete`, "POST", "{}", {
      "Upload-Capability": r.capability,
      "Idempotency-Key": "complete",
    });
  return {
    f,
    app,
    owner,
    share,
    session,
    deps,
    request,
    http,
    send,
    token,
    create,
    reserve,
    put,
    status,
    complete,
  };
}
it.each([
  { mode: "single", data: "abc" },
  { mode: "single", data: "" },
  { mode: "multipart", data: "abc" },
])("publishes and replays anonymous $mode uploads ($data)", async ({ mode, data }) => {
  const t = await fixture(),
    r = await t.reserve({ mode, declared_size: data.length });
  expect(await (await t.create({ mode, declared_size: data.length })).json()).toMatchObject({
    id: r.id,
    capability: r.capability,
  });
  expect(await uploadRow(env.DB, r.id)).toMatchObject({
    link_share_id: t.share.id,
    link_share_version: 1,
    selected_share_id: null,
    credential_id: `ss:${t.session.claims.session_id}`,
  });
  expect((await t.put(r, data, {}, mode === "multipart")).status).toBe(200);
  const done = await t.complete(r);
  expect(done.status).toBe(200);
  const op = await done.json<VisibleOperation>();
  expect(op.state).toBe("committed");
  expect(await (await t.complete(r)).json()).toEqual(op);
  expect(await (await t.status(r)).json()).toMatchObject({ state: "completed" });
  const row = (await uploadRow(env.DB, r.id))!;
  expect(row.data_calls).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT principal_kind,principal_id,credential_version FROM operations WHERE op_id=?",
    )
      .bind(op.id)
      .first(),
  ).toEqual({ principal_kind: "link_share", principal_id: t.share.id, credential_version: 1 });
  expect(
    await env.DB.prepare("SELECT actor_id FROM activity WHERE op_id=?")
      .bind(op.id)
      .first("actor_id"),
  ).toBeNull();
  expect(await (await env.BLOBS.get(`u/${t.f.ids.user}/b/${row.blob_id}`))!.text()).toBe(data);
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(row.reservation_id)
      .first("state"),
  ).toBe("consumed");
  const lookup = new Request(`${origin}/api/v1/operations/${op.id}`, {
    headers: t.request("", "GET").headers,
  });
  lookup.headers.set("X-Share-Id", t.share.id);
  expect(await (await t.http(lookup)).json()).toEqual(op);
});
it.each(["single", "multipart"])(
  "overwrites a directly shared file with %s without disclosing its parent",
  async (mode) => {
    const t = await fixture("edit", "file");
    const r = await t.reserve({
      mode,
      parentId: undefined,
      targetId: t.f.ids.file,
      targetRevision: 1,
      name: "File",
    });
    expect(r).not.toHaveProperty("parentId");
    expect(r).not.toHaveProperty("ownerId");
    expect((await t.put(r, "abc", {}, mode === "multipart")).status).toBe(428);
    expect((await t.put(r, "abc", { "If-Match": '"wrong"' }, mode === "multipart")).status).toBe(
      412,
    );
    expect(
      (await t.put(r, "abc", { "If-Match": `"b-${t.f.ids.blob}"` }, mode === "multipart")).status,
    ).toBe(200);
    const done = await t.complete(r);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ result: { nodeId: t.f.ids.file, status: 204 } });
    expect(
      await env.DB.prepare("SELECT current_blob_id,revision FROM nodes WHERE id=?")
        .bind(t.f.ids.file)
        .first(),
    ).toEqual({ current_blob_id: `${r.id}_blob`, revision: 2 });
  },
);
it("requires public CSRF, session binding, same origin, capability and canonical bodies", async () => {
  const t = await fixture();
  for (const [header, value, status] of [
    ["X-CSRF-Token", "", 403],
    ["Share-Session", "other", 412],
    ["Origin", "https://other.invalid", 403],
    ["Cookie", "", 401],
  ] as const) {
    const request = t.request(
      "/uploads",
      "POST",
      JSON.stringify({ mode: "single", parentId: t.f.ids.folder, name: "x", declared_size: 3 }),
      { "X-CSRF-Token": t.token },
    );
    request.headers.set(header, value);
    expect((await t.http(request)).status).toBe(status);
  }
  for (const field of ["spaceId", "ownerId", "share", "link_share_id", "credentialId"])
    expect((await t.create({ [field]: "forged" })).status).toBe(400);
  const r = await t.reserve();
  expect((await t.put(r, "abc", { "Upload-Capability": "wrong" })).status).toBe(403);
  expect((await t.put(r, "abc", { "Content-Length": "2" })).status).toBeGreaterThanOrEqual(400);
  expect(
    (
      await t.send(`/uploads/${r.id}/complete`, "POST", '{"lockTokens":[]}', {
        "Upload-Capability": r.capability,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await t.send(`/uploads/${r.id}?limit=1&limit=2`, "GET", undefined, {
        "Upload-Capability": r.capability,
      })
    ).status,
  ).toBe(400);
  expect(publicShareRoute(t.request(`/uploads/${r.id}/content`, "PUT", "abc"))).toBe(true);
});
it("rejects read links, outside parents, foreign receipts and another unlock credential", async () => {
  const read = await fixture("read");
  expect((await read.create()).status).toBe(403);
  const t = await fixture();
  expect((await t.create({ parentId: t.f.ids.root })).status).toBe(403);
  const r = await t.reserve();
  expect((await read.status(r)).status).toBe(403);
  const other = await unlockShare(t.app, (await t.deps.tokens.challenge(t.share.id, 1)).claims, {
    secret: t.share.secret,
  });
  const cookie = `__Host-ncf_share_${t.share.id}=${await t.deps.tokens.issue(other.claims)}`;
  const req = t.request(`/uploads/${r.id}`, "GET", undefined, {
    Cookie: cookie,
    "Upload-Capability": r.capability,
  });
  expect((await t.http(req)).status).toBe(412);
  req.headers.set("Share-Session", other.claims.session_id);
  expect((await t.http(req)).status).toBe(403);
});
it("checks owner quota before allocating a public upload", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=3 WHERE id=?").bind(t.f.ids.user).run();
  expect((await t.create()).status).toBe(507);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE credential_id=?")
      .bind(`ss:${t.session.claims.session_id}`)
      .first("n"),
  ).toBe(0);
});
it.each(["reserve", "dispatch", "publish", "receipt"])(
  "requires the upload action at %s even when create/edit remains permitted",
  async (phase) => {
    const t = await fixture();
    const r = phase === "reserve" ? null : await t.reserve();
    if (r && phase === "publish") expect((await t.put(r)).status).toBe(200);
    await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='upload'")
      .bind(t.share.id)
      .run();
    const response = !r
      ? await t.create()
      : phase === "dispatch"
        ? await t.put(r)
        : phase === "publish"
          ? await t.complete(r)
          : await t.status(r);
    expect(response.status).toBe(403);
    if (r) expect((await uploadRow(env.DB, r.id))?.data_calls).toBe(phase === "publish" ? 1 : 0);
  },
);
it.each(["version", "logout", "owner", "ancestor"])(
  "rejects stale %s before R2 dispatch",
  async (change) => {
    const t = await fixture(),
      r = await t.reserve();
    if (change === "version")
      await updateLinkShare(t.app, t.owner, t.share.id, 1, {
        kind: "link",
        rootNodeId: t.f.ids.folder,
        role: "read",
      });
    if (change === "logout") await logoutShare(t.app, t.session);
    if (change === "owner") {
      const other = foundationFixture(crypto.randomUUID(), Date.now());
      await atomicBatch(env.DB, other.statements);
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(t.f.ids.user).run();
    }
    if (change === "ancestor")
      await trashNode(t.app, {
        principal: accessPrincipal(t.owner),
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        nodeId: t.f.ids.folder,
        lockTokens: [],
      });
    expect((await t.put(r)).status).toBe(401);
    expect(await env.BLOBS.head(`u/${t.f.ids.user}/b/${r.id}_blob`)).toBeNull();
    expect((await uploadRow(env.DB, r.id))?.data_calls).toBe(0);
  },
);
it.each([
  ["reserve", "version"],
  ["publish", "version"],
  ["reserve", "action"],
  ["publish", "action"],
])("rechecks link authority at %s commit after %s changes", async (phase, change) => {
  const t = await fixture();
  const r = phase === "publish" ? await t.reserve() : null;
  if (r) expect((await t.put(r)).status).toBe(200);
  t.app.DB = injectBatch(
    (sql) =>
      phase === "reserve"
        ? sql.startsWith("INSERT INTO uploads(")
        : sql.includes("SET state='consumed'"),
    async () => {
      await env.DB.prepare(
        change === "version"
          ? "UPDATE shares SET version=version+1 WHERE id=?"
          : "DELETE FROM share_actions WHERE share_id=? AND action='upload'",
      )
        .bind(t.share.id)
        .run();
    },
    false,
  );
  const response = r ? await t.complete(r) : await t.create();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='public.txt'")
      .bind(t.f.ids.folder)
      .first("n"),
  ).toBe(0);
  if (r) expect((await uploadRow(env.DB, r.id))?.state).not.toBe("completed");
});
it.each(["single", "multipart"])(
  "stops %s uploads and retains storage until native cleanup is proved",
  async (mode) => {
    const t = await fixture(),
      r = await t.reserve({ mode });
    const response = await t.send(`/uploads/${r.id}`, "DELETE", "{}", {
      "Upload-Capability": r.capability,
    });
    expect(response.status).toBe(mode === "multipart" ? 202 : 200);
    expect((await t.put(r, "abc", {}, mode === "multipart")).status).toBe(409);
    if (mode === "multipart") {
      const errors: unknown[] = [];
      const db = {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async (statements: D1PreparedStatement[]) => {
          try {
            return await env.DB.batch(statements);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
      } as D1Database;
      await repairMultipartUploads(mutationEnv(db), env.BLOBS, 1);
      expect(errors).toEqual([]);
      expect((await uploadRow(env.DB, r.id))?.state).toBe("aborted");
    }
    const row = (await uploadRow(env.DB, r.id))!;
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(row.reservation_id)
        .first("state"),
    ).toBe("released");
  },
);
it.each(["single", "multipart"])(
  "settles a failed %s publication after the link is revoked",
  async (mode) => {
    const t = await fixture(),
      r = await t.reserve({ mode });
    expect((await t.put(r, "abc", {}, mode === "multipart")).status).toBe(200);
    await createFolder(t.app, {
      principal: accessPrincipal(t.owner),
      idempotencyKey: crypto.randomUUID(),
      spaceId: t.f.ids.space,
      parentId: t.f.ids.folder,
      name: "public.txt",
      lockTokens: [],
    });
    expect((await t.complete(r)).status).toBe(409);
    const row = (await uploadRow(env.DB, r.id))!;
    expect(row.state).toBe("failed");
    expect(row.completion_op_id).not.toBeNull();
    await updateLinkShare(t.app, t.owner, t.share.id, 1, {
      kind: "link",
      rootNodeId: t.f.ids.folder,
      role: "read",
    });
    await settleFailedCompletion(mutationEnv(), row, row.completion_op_id!);
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(row.reservation_id)
        .first("state"),
    ).toBe("released");
    expect(await env.BLOBS.head(`u/${t.f.ids.user}/b/${row.blob_id}`)).not.toBeNull();
    expect((await t.status(r)).status).toBe(401);
  },
);
it("reconciles lost reservation and publication replies without reallocating storage", async () => {
  const t = await fixture();
  t.app.DB = injectBatch(
    (sql) => sql.startsWith("INSERT INTO uploads("),
    async () => {
      throw new Error("lost_reservation_ack");
    },
    true,
  );
  const r = await t.reserve();
  t.app.DB = env.DB;
  expect(await (await t.create()).json()).toMatchObject({ id: r.id, capability: r.capability });
  expect((await t.put(r)).status).toBe(200);
  t.app.DB = injectBatch(
    (sql) => sql.includes("SET state='consumed'"),
    async () => {
      throw new Error("lost_commit_ack");
    },
    true,
  );
  const response = await t.complete(r);
  expect(response.status).toBe(200);
  const op = await response.json<VisibleOperation>();
  t.app.DB = env.DB;
  expect(await (await t.complete(r)).json()).toEqual(op);
  expect((await uploadRow(env.DB, r.id))?.data_calls).toBe(1);
});
