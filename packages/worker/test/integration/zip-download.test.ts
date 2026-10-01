import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { cleanupExpiredZipPins } from "../../src/jobs/gc";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { streamBudgetedZip } from "../../src/services/zipDownload";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const first = await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc");
  if (!first) throw new Error("r2_fixture_failed");
  const nested = crypto.randomUUID();
  const secondNode = crypto.randomUUID();
  const secondBlob = crypto.randomUUID();
  const secondKey = `u/${f.ids.user}/b/${secondBlob}`;
  const second = await env.BLOBS.put(secondKey, "de");
  if (!second) throw new Error("r2_fixture_failed");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
      values: [f.ids.blob, first.etag, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Nested','nested','folder',?,?)",
      values: [nested, f.ids.space, f.ids.user, f.ids.folder, now, now],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,2,?,'committed',?)",
      values: [secondBlob, f.ids.user, secondKey, `"b-${secondBlob}"`, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'Second','second','file',?,?,?)",
      values: [secondNode, f.ids.space, f.ids.user, nested, secondBlob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,2,?,?)",
      values: [secondBlob, second.etag, now],
    },
  ]);
  const ticketRing = await contentKeyRing("ticket", {
    ticket: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cookieRing = await contentKeyRing("cookie", {
    cookie: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ticketRing, cookieRing, "https://content.invalid");
  return {
    f,
    now,
    nested,
    secondNode,
    secondBlob,
    tokens,
    principal: {
      kind: "user" as const,
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch: 1,
    },
  };
}

it("issues, pins, redeems and streams a deterministic folder ZIP from the content origin", async () => {
  const { f, now, tokens, principal } = await fixture();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.folder }],
    "zip",
    now + 300_000,
  );
  const record = await env.DB.prepare(
    "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
  )
    .bind(issued.targetSetId)
    .first<{ id: string; ref: string; hash: string; totalBytes: number }>();
  if (!record) throw new Error("missing_target_set");
  const manifest = await loadTargetManifest(env.BLOBS, record);
  expect(manifest.v).toBe(2);
  if (manifest.v !== 2) throw new Error("unexpected_manifest");
  expect(manifest.entries.map((entry) => entry.path)).toEqual([
    "Folder/File",
    "Folder/Nested/Second",
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM blob_pins WHERE purpose='zip' AND substr(pin_id,1,?)=?",
    )
      .bind(`z:${issued.targetSetId}:`.length, `z:${issued.targetSetId}:`)
      .first<number>("count"),
  ).toBe(2);
  const accepted = await acceptContentTicket(mutationEnv(), tokens, issued.ticket);
  const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
  const contentEnv: Env = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const head = await handleContentHttp(
    new Request(`https://content.invalid/z/${issued.targetSetId}`, {
      method: "HEAD",
      headers: { Cookie: cookie },
    }),
    contentEnv,
    tokens,
  );
  expect(head.status).toBe(200);
  expect(head.headers.get("Content-Length")).toBe(String(manifest.outputSize));
  expect(head.headers.get("Accept-Ranges")).toBe("bytes");
  expect(head.body).toBeNull();
  const ranged = await handleContentHttp(
    new Request(`https://content.invalid/z/${issued.targetSetId}`, {
      headers: { Cookie: cookie, Range: "bytes=0-15" },
    }),
    contentEnv,
    tokens,
  );
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("Content-Range")).toBe(`bytes 0-15/${manifest.outputSize}`);
  expect(ranged.headers.get("Content-Length")).toBe("16");
  const rangeBytes = new Uint8Array(await ranged.arrayBuffer());
  const unsatisfiable = await handleContentHttp(
    new Request(`https://content.invalid/z/${issued.targetSetId}`, {
      headers: { Cookie: cookie, Range: `bytes=${manifest.outputSize}-` },
    }),
    contentEnv,
    tokens,
  );
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get("Content-Range")).toBe(`bytes */${manifest.outputSize}`);
  const response = await handleContentHttp(
    new Request(`https://content.invalid/z/${issued.targetSetId}`, {
      headers: { Cookie: cookie, Origin: contentEnv.APP_ORIGIN },
    }),
    contentEnv,
    tokens,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/zip");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(contentEnv.APP_ORIGIN);
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  expect(rangeBytes).toEqual(archiveBytes.subarray(0, 16));
  const archive = unzipSync(archiveBytes);
  expect(new TextDecoder().decode(archive["Folder/File"])).toBe("abc");
  expect(new TextDecoder().decode(archive["Folder/Nested/Second"])).toBe("de");
  expect(await env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId)).status()).toMatchObject({
    requests: 4,
    bytesCharged: manifest.outputSize + 16,
    byteLimit: (3 + 2 + 2 * 2_200) * 3,
  });
  const wrong = await handleContentHttp(
    new Request(`https://content.invalid/z/${crypto.randomUUID()}`, {
      headers: { Cookie: cookie },
    }),
    contentEnv,
    tokens,
  );
  expect(wrong.status).toBe(404);
  await cancelContentTicket(mutationEnv(), principal, issued.ticketId);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM blob_pins WHERE purpose='zip' AND substr(pin_id,1,?)=?",
    )
      .bind(`z:${issued.targetSetId}:`.length, `z:${issued.targetSetId}:`)
      .first<number>("count"),
  ).toBe(0);
});

it("removes expired ZIP pins through bounded admitted cleanup", async () => {
  const { f, now, tokens, principal } = await fixture();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.folder }],
    "zip",
    now + 300_000,
  );
  const expired = Date.now() - 2_000;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE tickets SET issued_at=?,expires_at=? WHERE id=?",
      values: [expired - 1_000, expired, issued.ticketId],
    },
    {
      sql: "UPDATE target_sets SET expires_at=? WHERE id=?",
      values: [expired, issued.targetSetId],
    },
    {
      sql: "UPDATE blob_pins SET expires_at=? WHERE purpose='zip' AND substr(pin_id,1,?)=?",
      values: [expired, `z:${issued.targetSetId}:`.length, `z:${issued.targetSetId}:`],
    },
  ]);
  expect(await cleanupExpiredZipPins(mutationEnv(), 1, 1)).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM blob_pins WHERE purpose='zip' AND substr(pin_id,1,?)=?",
    )
      .bind(`z:${issued.targetSetId}:`.length, `z:${issued.targetSetId}:`)
      .first<number>("count"),
  ).toBe(0);
});

it("rejects changed R2 metadata before returning ZIP headers", async () => {
  const { f, now, tokens, principal } = await fixture();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.file }],
    "zip",
    now + 300_000,
  );
  const accepted = await acceptContentTicket(mutationEnv(), tokens, issued.ticket);
  await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "xyz");
  const response = await handleContentHttp(
    new Request(`https://content.invalid/z/${issued.targetSetId}`, {
      method: "HEAD",
      headers: { Cookie: accepted.setCookie.split(";", 1)[0] ?? "" },
    }),
    {
      ...mutationEnv(),
      APP_ORIGIN: "https://app.invalid",
      CONTENT_ORIGIN: "https://content.invalid",
    },
    tokens,
  );
  expect(response.status).toBe(503);
});

it("cancels an active R2 reader when its ZIP ticket is cancelled", async () => {
  const { f, now, tokens, principal } = await fixture();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.file }],
    "zip",
    now + 300_000,
  );
  const accepted = await acceptContentTicket(mutationEnv(), tokens, issued.ticket);
  let sourceCancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([97]));
    },
    pull() {
      return new Promise(() => undefined);
    },
    cancel() {
      sourceCancelled = true;
    },
  });
  const bucket = {
    head: env.BLOBS.head.bind(env.BLOBS),
    get: async (key: string) => {
      const object = await env.BLOBS.get(key);
      if (!object || key !== `u/${f.ids.user}/b/${f.ids.blob}`) return object;
      return new Proxy(object, {
        get(target, property) {
          return property === "body" ? source : Reflect.get(target, property, target);
        },
      });
    },
  } as R2Bucket;
  const response = await streamBudgetedZip(
    env.DB,
    bucket,
    env.BUDGETS,
    tokens,
    accepted.setCookie.split(";", 1)[0] ?? "",
    issued.targetSetId,
    new Request(`https://content.invalid/z/${issued.targetSetId}`),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_zip_body");
  await reader.read();
  await cancelContentTicket(mutationEnv(), principal, issued.ticketId);
  const stopped = async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("zip_completed_after_cancel");
    }
  };
  await expect(
    Promise.race([
      stopped(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("zip_cancel_timeout")), 4_000)),
    ]),
  ).rejects.not.toThrow(/zip_cancel_timeout/);
  expect(sourceCancelled).toBe(true);
});

it("rejects overlapping selections and portable case-fold collisions", async () => {
  const { f, now, nested, tokens, principal } = await fixture();
  await expect(
    issueContentTicket(
      mutationEnv(),
      env.BLOBS,
      tokens,
      principal,
      [
        { spaceId: f.ids.space, nodeId: f.ids.folder },
        { spaceId: f.ids.space, nodeId: f.ids.file },
      ],
      "zip",
      now + 300_000,
    ),
  ).rejects.toThrow(/zip_selection_overlap/);
  const blob = crypto.randomUUID();
  const node = crypto.randomUUID();
  const key = `u/${f.ids.user}/b/${blob}`;
  const object = await env.BLOBS.put(key, "x");
  if (!object) throw new Error("r2_fixture_failed");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,1,?,'committed',?)",
      values: [blob, f.ids.user, key, `"b-${blob}"`, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'file','file','file',?,?,?)",
      values: [node, f.ids.space, f.ids.user, nested, blob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,1,?,?)",
      values: [blob, object.etag, now],
    },
  ]);
  await expect(
    issueContentTicket(
      mutationEnv(),
      env.BLOBS,
      tokens,
      principal,
      [
        { spaceId: f.ids.space, nodeId: f.ids.file },
        { spaceId: f.ids.space, nodeId: node },
      ],
      "zip",
      now + 300_000,
    ),
  ).rejects.toThrow(/zip_path_collision/);
});
