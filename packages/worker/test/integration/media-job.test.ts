import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";
import { atomicBatch } from "../../src/db/primary";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { listGallery } from "../../src/services/gallery";
import { foundationFixture } from "../fixtures/foundation";
import { stillAvifWithMpegNoise, tinyPng } from "../fixtures/images";
import { grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("projects current image dimensions and one immutable sm256 derivative", async () => {
  const now = Date.now() - 1_000;
  const bytes = tinyPng();
  const f = foundationFixture(crypto.randomUUID(), now);
  const statements = f.statements.map((statement) =>
    statement.sql.startsWith("INSERT INTO blobs")
      ? {
          ...statement,
          sql: statement.sql.replace(",3,?,'committed'", ",?,?,'committed'"),
          values: [
            ...statement.values!.slice(0, 3),
            bytes.byteLength,
            ...statement.values!.slice(3),
          ],
        }
      : statement,
  );
  await atomicBatch(env.DB, statements);
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=1 WHERE singleton=1").run();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const stored = await env.BLOBS.put(key, bytes);
  if (!stored) throw new Error("fixture_r2_put_failed");
  const outboxId = crypto.randomUUID();
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  const operands = JSON.stringify({ parentId: f.ids.folder });
  const result = JSON.stringify({ status: 201, nodeId: f.ids.file });
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [f.ids.blob, bytes.byteLength, stored.etag, now],
    },
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
        request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json)
        VALUES(?,'user',?,?,?,'node.create','committed','digest',?,?,?,?,0,1,1,?,?)`,
      values: [
        outboxId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        1,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        operands,
        result,
      ],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,'node.created',?,'sent',1,1,1)`,
      values: [outboxId, outboxId, f.ids.file],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [outboxId, f.ids.file],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();

  try {
    expect(await consumeOutbox(mutationEnv(), outboxId)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.ids.blob)
        .first("mime_sniffed"),
    ).toBe("image/png");
    expect(
      await env.DB.prepare(
        "SELECT blob_id,generator_version,width,height,taken_at,orientation,camera_make FROM node_media WHERE node_id=?",
      )
        .bind(f.ids.file)
        .first(),
    ).toEqual({
      blob_id: f.ids.blob,
      generator_version: "image-metadata-v1",
      width: 1,
      height: 1,
      taken_at: null,
      orientation: null,
      camera_make: null,
    });
    const derivative = await env.DB.prepare(
      `SELECT state,variant,generator_version,attempts,r2_key AS key,size,r2_etag AS etag
        FROM derivative_results WHERE blob_id=?`,
    )
      .bind(f.ids.blob)
      .first<{
        state: string;
        variant: string;
        generator_version: string;
        attempts: number;
        key: string;
        size: number;
        etag: string;
      }>();
    expect(derivative).toMatchObject({
      state: "ready",
      variant: "sm256",
      generator_version: "image-sm256-v1",
      attempts: 1,
    });
    expect(derivative?.key).toMatch(
      new RegExp(`^u/${f.ids.user}/d/${f.ids.blob}/image-sm256-v1/sm256/.+\\.webp$`),
    );
    const object = derivative ? await env.BLOBS.head(derivative.key) : null;
    expect(object).toMatchObject({ size: derivative?.size, etag: derivative?.etag });
    expect(await consumeOutbox(mutationEnv(), outboxId)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM derivative_results WHERE blob_id=?")
        .bind(f.ids.blob)
        .first("count"),
    ).toBe(1);
  } finally {
    const derivativeKeys = await env.BLOBS.list({
      prefix: `u/${f.ids.user}/d/${f.ids.blob}/`,
    });
    await env.BLOBS.delete([key, ...derivativeKeys.objects.map((object) => object.key)]);
  }
});

it("keeps a real still AVIF in Gallery when an MPEG-like free box and thumbnail failure occur", async () => {
  const bytes = stillAvifWithMpegNoise();
  const now = Date.now() - 1000;
  const f = foundationFixture(crypto.randomUUID(), now);
  const statements = f.statements.map((statement) =>
    statement.sql.startsWith("INSERT INTO blobs")
      ? {
          ...statement,
          sql: statement.sql.replace(",3,?,'committed'", ",?,?,'committed'"),
          values: [...statement.values!.slice(0, 3), bytes.length, ...statement.values!.slice(3)],
        }
      : statement,
  );
  await atomicBatch(env.DB, statements);
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=1 WHERE singleton=1").run();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const stored = await env.BLOBS.put(key, bytes);
  if (!stored) throw new Error("fixture_r2_put_failed");
  const outboxId = crypto.randomUUID();
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  const operands = JSON.stringify({ parentId: f.ids.folder });
  const result = JSON.stringify({ status: 201, nodeId: f.ids.file });
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [f.ids.blob, bytes.length, stored.etag, now],
    },
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
        request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json)
        VALUES(?,'user',?,?,?,'node.create','committed','digest',?,?,?,?,0,1,1,?,?)`,
      values: [
        outboxId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        1,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        operands,
        result,
      ],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,'node.created',?,'sent',1,1,1)`,
      values: [outboxId, outboxId, f.ids.file],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [outboxId, f.ids.file],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();

  const failedImages = {
    input: () => ({
      transform: () => ({
        output: async () => ({ contentType: () => "image/png" }),
      }),
    }),
  } as unknown as ImagesBinding;
  try {
    expect(await consumeOutbox({ ...mutationEnv(), IMAGES: failedImages }, outboxId)).toBe(
      "completed",
    );
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.ids.blob)
        .first("mime_sniffed"),
    ).toBe("image/avif");
    expect(
      await env.DB.prepare(
        "SELECT generator_version,width,height,projection_state FROM node_media WHERE node_id=?",
      )
        .bind(f.ids.file)
        .first(),
    ).toEqual({
      generator_version: "image-metadata-v1",
      width: 16,
      height: 12,
      projection_state: "ready",
    });
    expect(
      await env.DB.prepare("SELECT state,error_code FROM derivative_results WHERE blob_id=?")
        .bind(f.ids.blob)
        .first(),
    ).toEqual({ state: "failed", error_code: "output_type" });
    const ring = await contentKeyRing("cursor", {
      cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    });
    const gallery = await listGallery(
      env.DB,
      {
        kind: "user",
        user_id: f.ids.user,
        credential_id: f.ids.credential,
        epoch: 1,
      },
      f.ids.root,
      true,
      new GalleryCursorTokens(ring),
    );
    expect(gallery.items).toEqual([
      expect.objectContaining({
        id: f.ids.file,
        currentBlobId: f.ids.blob,
        mime: "image/avif",
        width: 16,
        height: 12,
        thumbnail: "failed",
      }),
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM node_audio WHERE node_id=?")
        .bind(f.ids.file)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.BLOBS.delete(key);
  }
});
