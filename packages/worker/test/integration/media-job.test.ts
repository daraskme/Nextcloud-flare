import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { foundationFixture } from "../fixtures/foundation";
import { tinyPng } from "../fixtures/images";
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
