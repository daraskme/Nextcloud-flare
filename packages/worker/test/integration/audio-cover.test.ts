import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleThumbnailHttp } from "../../src/api/thumbnails";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { AUDIO_COVER_GENERATOR } from "../../src/media/images/transform";
import { listAudio } from "../../src/services/audio";
import { issueContentTicket } from "../../src/services/contentTicket";
import { auditOwnerLedger } from "../../src/services/refs";
import { loadTargetManifest, type TargetManifestRecord } from "../../src/services/targetManifest";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { coverBytes, encodedCovers } from "../fixtures/tracks/encodedCovers";
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
async function fixture(name: keyof typeof encodedCovers = "cover.opus") {
  const bytes = coverBytes(name),
    f = await davPutFixture(bytes.length);
  const result = await f.run({}, new Blob([bytes]).stream());
  if (result.kind !== "terminal") throw new Error("cover_fixture_upload");
  const event = result.operation.id + "_event";
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(result.operation.id)
    .first<{ id: string; blob: string }>())!;
  expect(
    await dispatchOutbox(
      f.app,
      { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
      event,
      1,
    ),
  ).toBe("sent");
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => env.IMAGES.input(stream));
  const app = {
    ...f.app,
    IMAGES: { input } as unknown as ImagesBinding,
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ring, ring, app.CONTENT_ORIGIN);
  const outputs = async () =>
    (
      await env.DB.prepare("SELECT * FROM derivative_results WHERE blob_id=? ORDER BY variant")
        .bind(node.blob)
        .all<Record<string, unknown>>()
    ).results;
  const list = () => listAudio(env.DB, principal, node.id, new AudioCursorTokens(ring));
  const ticket = () =>
    issueContentTicket(
      app,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: node.id, variant: "sm" }],
      "thumb",
      Date.now() + 300000,
    );
  return {
    ...f,
    bytes,
    node,
    event,
    input,
    app,
    principal,
    ring,
    tokens,
    outputs,
    list,
    ticket,
    credentialId: f.input.principal.credential_id.slice(3),
  };
}
it.each(Object.keys(encodedCovers) as (keyof typeof encodedCovers)[])(
  "publishes %s artwork once with native receipts, quota and authorized image bytes",
  async (name) => {
    const f = await fixture(name),
      before = (await auditOwnerLedger(env.DB, f.ids.user))!;
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(f.input).toHaveBeenCalledTimes(2);
    const outputs = await f.outputs();
    expect(outputs).toHaveLength(2);
    for (const row of outputs) {
      expect(row).toMatchObject({
        kind: "cover",
        state: "ready",
        generator_version: AUDIO_COVER_GENERATOR,
        attempts: 1,
      });
      const object = (await env.BLOBS.get(row.r2_key as string))!;
      expect(object.size).toBe(row.size);
    }
    expect((await f.list()).items[0]).toMatchObject({
      id: f.node.id,
      currentBlobId: f.node.blob,
      cover: "ready",
    });
    const costs = await env.DB.prepare(
      "SELECT source_json FROM image_transform_attempts WHERE blob_id=?",
    )
      .bind(f.node.blob)
      .all<{ source_json: string }>();
    for (const cost of costs.results)
      expect(JSON.parse(cost.source_json)).toMatchObject({
        size: f.bytes.length,
        cover: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) },
      });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      used_bytes: before.used_bytes,
      image_reserved_bytes: 0,
      incorrect_refs: 0,
      physical_bytes: before.physical_bytes + outputs.reduce((n, r) => n + (r.size as number), 0),
    });
    const issued = await f.ticket(),
      accepted = await acceptContentTicket(f.app, f.tokens, issued.ticket);
    const set = (await env.DB.prepare(
      "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
    )
      .bind(issued.targetSetId)
      .first<TargetManifestRecord>())!;
    expect(await loadTargetManifest(env.BLOBS, set)).toMatchObject({
      v: 3,
      targets: [
        {
          generator: AUDIO_COVER_GENERATOR,
          purpose: "thumb",
          nodeId: f.node.id,
          blobId: f.node.blob,
        },
      ],
    });
    const response = await handleThumbnailHttp(
      new Request(`${f.app.APP_ORIGIN}/api/v1/nodes/${f.node.id}/thumb?variant=sm`, {
        headers: {
          Origin: f.app.APP_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Session": accepted.sessionId,
        },
      }),
      f.app,
      f.principal,
      f.node.id,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect((await response.arrayBuffer()).byteLength).toBe(
      outputs.find((r) => r.variant === "sm")!.size,
    );
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(f.input).toHaveBeenCalledTimes(2);
  },
);
it("reuses saved artwork after metadata completion loses its acknowledgement", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO node_audio("),
    async () => {
      throw new Error("lost_metadata_ack");
    },
    true,
  );
  await consumeOutbox({ ...f.app, DB: db }, f.event).catch(() => {});
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(await f.outputs()).toHaveLength(2);
});
it("refuses an issued cover when the original is replaced", async () => {
  const f = await fixture();
  await consumeOutbox(f.app, f.event);
  const issued = await f.ticket(),
    accepted = await acceptContentTicket(f.app, f.tokens, issued.ticket);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  const response = await handleThumbnailHttp(
    new Request(`${f.app.APP_ORIGIN}/api/v1/nodes/${f.node.id}/thumb?variant=sm`, {
      headers: {
        Origin: f.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Session": accepted.sessionId,
      },
    }),
    f.app,
    f.principal,
    f.node.id,
  );
  expect(response.status).toBe(404);
});

it("records a known cover rejection without losing audio tags or paying again", async () => {
  const f = await fixture(),
    before = (await auditOwnerLedger(env.DB, f.ids.user))!;
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => ({
    transform: () => ({
      output: async () => {
        await new Response(stream).arrayBuffer();
        throw Object.assign(new Error("IMAGES_TRANSFORM_ERROR"), { code: 9520 });
      },
    }),
  }));
  const app = { ...f.app, IMAGES: { input } as unknown as ImagesBinding };
  expect(await consumeOutbox(app, f.event)).toBe("completed");
  expect(await f.outputs()).toMatchObject([
    { kind: "cover", state: "failed", attempts: 1 },
    { kind: "cover", state: "failed", attempts: 1 },
  ]);
  expect((await f.list()).items[0]).toMatchObject({ title: "テスト曲", cover: "failed" });
  expect(await consumeOutbox(app, f.event)).toBe("completed");
  expect(input).toHaveBeenCalledTimes(2);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: before.physical_bytes,
    image_reserved_bytes: 0,
    incorrect_refs: 0,
  });
});

it("does not transform extracted artwork after authorization is revoked during its source read", async () => {
  const f = await fixture();
  const get = (async (...args: Parameters<R2Bucket["get"]>) => {
    const result = await env.BLOBS.get(...args);
    await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.credentialId)
      .run();
    return result;
  }) as R2Bucket["get"];
  expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("retry");
  expect(f.input).not.toHaveBeenCalled();
  expect(await f.outputs()).toHaveLength(0);
});
