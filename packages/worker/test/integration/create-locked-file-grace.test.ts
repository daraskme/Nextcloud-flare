import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  type CreateLockedFileOutcome,
  type CreateLockedFileRequest,
  createLockedEmptyFile,
} from "../../src/services/createLockedFile";
import { davBucket, davPutFixture } from "../fixtures/davPut";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run());

async function fixture() {
  const f = await davPutFixture(0);
  const input: CreateLockedFileRequest = {
    ...f.input,
    displayHref: "/dav/dav.txt",
    depth: "0",
    ownerText: "",
    timeoutSeconds: 60,
  };
  return { ...f, input };
}

it("never deletes the committed empty object when a concurrent identical operation wins", async () => {
  const f = await fixture();
  let key = "",
    deleted = 0,
    winner: CreateLockedFileOutcome | undefined;
  const bucket = davBucket({
    async put(name, value, options) {
      key = name;
      const object = await env.BLOBS.put(name, value, options);
      winner = await createLockedEmptyFile(f.app, f.input);
      return object;
    },
    async delete(name) {
      deleted++;
      await env.BLOBS.delete(name);
    },
  });
  await expect(createLockedEmptyFile({ ...f.app, BLOBS: bucket }, f.input)).rejects.toThrow();
  expect(winner).toMatchObject({ kind: "locked", outcome: { operation: { state: "committed" } } });
  expect(deleted).toBe(0);
  expect(await env.BLOBS.head(key)).toMatchObject({ size: 0 });
  expect(
    await env.DB.prepare(
      "SELECT b.state,b.ref_count FROM blobs b JOIN nodes n ON n.current_blob_id=b.id WHERE b.r2_key=?",
    )
      .bind(key)
      .first(),
  ).toEqual({ state: "committed", ref_count: 1 });
});

it("retains an uncertain empty PUT for orphan inventory when its HEAD is unavailable", async () => {
  const f = await fixture();
  let key = "",
    deleted = 0;
  const bucket = davBucket({
    async put(name, value, options) {
      key = name;
      await env.BLOBS.put(name, value, options);
      throw new Error("put_ack_lost");
    },
    async head() {
      throw new Error("head_unavailable");
    },
    async delete(name) {
      deleted++;
      await env.BLOBS.delete(name);
    },
  });
  await expect(createLockedEmptyFile({ ...f.app, BLOBS: bucket }, f.input)).rejects.toThrow(
    "head_unavailable",
  );
  expect(deleted).toBe(0);
  expect(await env.BLOBS.head(key)).toMatchObject({ size: 0 });
  expect(await env.DB.prepare("SELECT 1 FROM blobs WHERE r2_key=?").bind(key).first()).toBeNull();
});

it("leaves a known failed namespace publication for the same orphan grace", async () => {
  const f = await fixture();
  let key = "",
    deleted = 0;
  const bucket = davBucket({
    async put(name, value, options) {
      key = name;
      const object = await env.BLOBS.put(name, value, options);
      await f.conflict();
      return object;
    },
    async delete(name) {
      deleted++;
      await env.BLOBS.delete(name);
    },
  });
  const result = await createLockedEmptyFile({ ...f.app, BLOBS: bucket }, f.input);
  expect(result).toMatchObject({ kind: "locked", outcome: { operation: { state: "failed" } } });
  expect(deleted).toBe(0);
  expect(await env.BLOBS.head(key)).toMatchObject({ size: 0 });
  expect(await env.DB.prepare("SELECT 1 FROM blobs WHERE r2_key=?").bind(key).first()).toBeNull();
});
