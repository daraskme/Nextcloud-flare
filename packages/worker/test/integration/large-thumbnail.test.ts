import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleLargeThumbnailHttp } from "../../src/api/largeThumbnail";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { imageRequestKey } from "../../src/jobs/imageRequestAuthority";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { createInternalShare } from "../../src/services/internalShares";
import { createLinkShare } from "../../src/services/linkShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { requestLargeThumbnail } from "../../src/services/requestLargeThumbnail";
import { unlockShare } from "../../src/services/shareUnlock";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const bytes = imageBytes("pattern.png"),
    f = await davPutFixture(bytes.length);
  const saved = await f.run({}, new Blob([bytes]).stream());
  if (saved.kind !== "terminal" || saved.operation.state !== "committed")
    throw new Error("fixture_upload");
  const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  const jobs = { send } as unknown as typeof env.JOBS;
  const app = { ...f.app, JOBS: jobs };
  expect(await dispatchOutbox(app, jobs, saved.operation.id + "_event", 1)).toBe("sent");
  expect(await consumeOutbox(app, saved.operation.id + "_event")).toBe("completed");
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(saved.operation.id)
    .first<{ id: string; blob: string }>())!;
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => env.IMAGES.input(stream));
  const generated = { ...app, IMAGES: { input } as unknown as ImagesBinding };
  const event = await imageRequestKey(node.blob);
  const request = (key = crypto.randomUUID(), target = node.id, current = app) =>
    requestLargeThumbnail(current, principal, target, node.blob, key);
  const costs = () =>
    env.DB.prepare("SELECT * FROM image_transform_attempts WHERE blob_id=? AND variant='lg'")
      .bind(node.blob)
      .all<Record<string, unknown>>();
  const result = () =>
    env.DB.prepare("SELECT * FROM derivative_results WHERE blob_id=? AND variant='lg'")
      .bind(node.blob)
      .first<Record<string, unknown>>();
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(event).run();
  return {
    ...f,
    app,
    generated,
    node,
    principal,
    input,
    send,
    event,
    request,
    costs,
    result,
    release,
  };
}

it("requests one lazy lg using the current reader after the uploader credential expires", async () => {
  const f = await fixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  expect(await f.result()).toBeNull();
  // Revoke the saved DAV credential; the Access reader owns the new request.
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE user_id=?")
    .bind(Date.now(), f.ids.user)
    .run();
  expect(await f.request()).toMatchObject({ state: "pending", variant: "lg", blobId: f.node.blob });
  expect(await f.request()).toMatchObject({ state: "pending" });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM permits WHERE space_id=? AND state='open'")
      .bind(f.ids.space)
      .first("n"),
  ).toBe(0);
  expect(await consumeOutbox(f.generated, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
  expect(await f.request()).toMatchObject({ state: "ready" });
  const output = (await f.result())!;
  expect(output).toMatchObject({ state: "ready", attempts: 1 });
  expect(await env.IMAGES.info((await env.BLOBS.get(output.r2_key as string))!.body)).toMatchObject(
    { format: "image/webp", width: 1600, height: 900 },
  );
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    incorrect_refs: 0,
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes + (output.size as number),
  });
  expect(await consumeOutbox(f.generated, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
  expect((await f.costs()).results).toHaveLength(1);
});

it("deduplicates COW aliases before enqueue and across concurrent consumer claims", async () => {
  const f = await fixture(),
    alias = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'alias','alias','file',?,1,1)",
  )
    .bind(alias, f.ids.space, f.ids.user, f.ids.folder, f.node.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_media(node_id,blob_id,generator_version,width,height) VALUES(?,?,'image-metadata-v1',1920,1080)",
  )
    .bind(alias, f.node.blob)
    .run();
  await f.request();
  await f.request(crypto.randomUUID(), alias);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE kind='image.requested' AND payload_ref=?",
    )
      .bind(f.event)
      .first("n"),
  ).toBe(1);
  const both = await Promise.all([
    consumeOutbox(f.generated, f.event),
    consumeOutbox(f.generated, f.event),
  ]);
  expect(both).toContain("completed");
  expect(f.input).toHaveBeenCalledOnce();
  expect(await f.request(crypto.randomUUID(), alias)).toMatchObject({
    state: "ready",
    nodeId: alias,
  });
});

it("recovers a lost acceptance ACK and preserves the exact idempotency intent", async () => {
  const f = await fixture(),
    key = crypto.randomUUID();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO outbox"),
    async () => {
      throw new Error("lost acknowledgement");
    },
    true,
  );
  expect(await f.request(key, f.node.id, { ...f.app, DB: db })).toMatchObject({ state: "pending" });
  expect(await f.request(key)).toMatchObject({ state: "pending" });
  expect(await consumeOutbox(f.generated, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
});

it.each(["credential", "parent", "blob"])(
  "rejects %s changes after accepting the request",
  async (change) => {
    const f = await fixture();
    await f.request();
    if (change === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    else if (change === "parent")
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
    else
      await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
        .bind(f.node.id)
        .run();
    expect(await consumeOutbox(f.generated, f.event)).toBe("retry");
    expect(f.input).not.toHaveBeenCalled();
    expect((await f.costs()).results).toHaveLength(0);
  },
);

it("resumes a stored lg after publication interruption without another transform or PUT", async () => {
  const f = await fixture();
  await f.request();
  const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  const db = injectBatch(
    (sql) => sql.includes("UPDATE derivative_results SET state='ready'"),
    async () => {
      throw new Error("interruption");
    },
    false,
  );
  const app = { ...f.generated, BLOBS: davBucket({ put }) };
  expect(await consumeOutbox({ ...app, DB: db }, f.event)).toBe("retry");
  await f.release();
  expect(await consumeOutbox(app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
  expect(put).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "uses the selected internal reader and rechecks grant revocation=%s",
  async (revoke) => {
    const f = await fixture(),
      recipient = foundationFixture(crypto.randomUUID(), Date.now());
    await atomicBatch(env.DB, recipient.statements);
    const email = `${recipient.ids.user}@example.invalid`;
    await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
      .bind(email, recipient.ids.user)
      .run();
    const share = await createInternalShare(
      f.app,
      (await readAccessSession(env.DB, f.ids.credential, 1))!,
      { kind: "internal", rootNodeId: f.ids.folder, role: "read", recipients: [email] },
    );
    const reader = {
      kind: "user" as const,
      user_id: recipient.ids.user,
      credential_id: recipient.ids.credential,
      epoch: 1,
    };
    await expect(
      requestLargeThumbnail(f.app, reader, f.node.id, f.node.blob, crypto.randomUUID()),
    ).rejects.toThrow();
    const selected = { ...reader, selected_share: { id: share.id, version: 1 } };
    expect(
      await requestLargeThumbnail(f.app, selected, f.node.id, f.node.blob, crypto.randomUUID()),
    ).toMatchObject({ state: "pending" });
    if (revoke)
      await env.DB.prepare("UPDATE share_grants SET disabled_at=? WHERE share_id=?")
        .bind(Date.now(), share.id)
        .run();
    expect(await consumeOutbox(f.generated, f.event)).toBe(revoke ? "retry" : "completed");
    expect(f.input).toHaveBeenCalledTimes(revoke ? 0 : 1);
  },
);

it("rechecks current authority in the acceptance batch and before publication", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO outbox"),
    async () => {
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
    },
    false,
  );
  await expect(f.request(crypto.randomUUID(), f.node.id, { ...f.app, DB: db })).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT 1 FROM outbox WHERE outbox_id=?").bind(f.event).first(),
  ).toBeNull();
  const next = await fixture();
  await next.request();
  const publish = injectBatch(
    (sql) => sql.includes("UPDATE derivative_results SET state='ready'"),
    async () => {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), next.ids.session)
        .run();
    },
    false,
  );
  expect(await consumeOutbox({ ...next.generated, DB: publish }, next.event)).toBe("retry");
  expect(await next.result()).toMatchObject({ state: "running" });
  expect(next.input).toHaveBeenCalledOnce();
});

it("requires CSRF and a fixed original; rejects client bytes, variants and query operands", async () => {
  const f = await fixture(),
    app = { ...f.app, APP_ORIGIN: "https://app.invalid" };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const csrf = new CsrfTokens(ring, ring, app.APP_ORIGIN);
  const req = (body: unknown, token?: string, query = "") =>
    new Request(`${app.APP_ORIGIN}/api/v1/nodes/${f.node.id}/thumb${query}`, {
      method: "POST",
      headers: {
        Origin: app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  const { token } = await csrf.issue(
    env.DB,
    new Request(`${app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { Origin: app.APP_ORIGIN, "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.principal.credential_id, epoch: 1 },
  );
  const http = (r: Request) => handleLargeThumbnailHttp(r, app, f.principal, f.node.id, csrf);
  const body = { blobId: f.node.blob, variant: "lg" };
  expect((await http(req(body))).status).toBe(403);
  for (const invalid of [
    { ...body, bytes: "client-image" },
    { ...body, variant: "sm" },
    { ...body, generator: "old" },
  ])
    expect((await http(req(invalid, token))).status).toBe(400);
  expect((await http(req(body, token, "?variant=lg"))).status).toBe(400);
  expect((await http(req({ ...body, blobId: f.ids.blob }, token))).status).toBe(404);
  expect((await http(req(body, token))).status).toBe(202);
  expect(f.input).not.toHaveBeenCalled();
});

it("accepts anonymous read-link generation only with the original share session", async () => {
  const f = await fixture(),
    app = {
      ...f.app,
      APP_ORIGIN: "https://app.invalid",
      EDGE_LIMITER: { limit: async () => ({ success: true }) },
    };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ShareTokens(ring, app.APP_ORIGIN),
    csrf = new CsrfTokens(ring, ring, app.APP_ORIGIN);
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(app, owner, {
    kind: "link",
    rootNodeId: f.node.id,
    role: "read",
  });
  const session = await unlockShare(app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(session.claims)}`;
  const request = (suffix: string, body?: unknown, token?: string) =>
    new Request(`${app.APP_ORIGIN}/api/v1/public/shares/${share.id}${suffix}`, {
      method: "POST",
      headers: {
        Origin: app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        Cookie: cookie,
        "Share-Session": session.claims.session_id,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const http = (r: Request) => handlePublicShareHttp(r, app, 1, { tokens, csrf });
  const { token } = await (await http(request("/csrf"))).json<{ token: string }>();
  const body = { blobId: f.node.blob, variant: "lg" };
  const valid = () => request(`/thumb/${f.node.id}`, body, token);
  expect(publicShareRoute(valid())).toBe(true);
  const missing = valid();
  missing.headers.delete("Share-Session");
  expect((await http(missing)).status).toBe(412);
  expect(
    (await http(request(`/thumb/${f.ids.file}`, { blobId: f.ids.blob, variant: "lg" }, token)))
      .status,
  ).toBe(404);
  expect((await http(valid())).status).toBe(202);
  expect(await consumeOutbox(f.generated, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
  expect((await http(valid())).status).toBe(200);
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), share.id)
    .run();
  expect([401, 404]).toContain((await http(valid())).status);
});

it("retains a known native failure and never pays again for a new viewer request", async () => {
  const f = await fixture();
  await f.request();
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => ({
    transform: () => ({
      output: async () => {
        await new Response(stream).arrayBuffer();
        throw Object.assign(new Error("IMAGES_TRANSFORM_ERROR"), { code: 9520 });
      },
    }),
  }));
  expect(
    await consumeOutbox({ ...f.app, IMAGES: { input } as unknown as ImagesBinding }, f.event),
  ).toBe("completed");
  expect(await f.request()).toMatchObject({ state: "failed" });
  expect(await f.request()).toMatchObject({ state: "failed" });
  expect((await f.costs()).results).toMatchObject([{ state: "failed" }]);
  expect(input).toHaveBeenCalledOnce();
});

it("uses the invocation's remaining transform budget instead of starting a new lg budget", async () => {
  const f = await fixture();
  await f.request();
  expect(
    await consumeOutbox(
      f.generated,
      f.event,
      Date.now() + 25000,
      { reads: 0, bytes: 0 },
      { transforms: 2 },
    ),
  ).toBe("retry");
  expect(f.input).not.toHaveBeenCalled();
  expect((await f.costs()).results).toHaveLength(0);
  await f.release();
  expect(await consumeOutbox(f.generated, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledOnce();
});
