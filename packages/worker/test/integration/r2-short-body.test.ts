import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload } from "../../src/services/uploads/create";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function admitted(): Env {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation,
        acquireSystemMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    CONTROL: doEnv.CONTROL,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const invoke = async <T>(callback: (lock: LockDO) => Promise<T>) => {
          const result = await runInDurableObject(env.LOCKS.get(id), async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_failed",
              };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireCreate: (request: Parameters<LockDO["acquireCreate"]>[0]) =>
            invoke((lock) => lock.acquireCreate(request)),
          acquireNodeWrite: (request: Parameters<LockDO["acquireNodeWrite"]>[0]) =>
            invoke((lock) => lock.acquireNodeWrite(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

it("checks real R2 stream length and blocks completion while data is missing", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: secret }));
  const created = await createSingleUpload(
    mutationEnv(),
    {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      parentId: f.ids.folder,
      name: "upload.txt",
      declaredSize: 3,
    },
    capabilities,
  );
  const app = admitted();
  const complete = () =>
    completeSingleUpload(
      app,
      principal,
      created.id,
      created.capability,
      capabilities,
      "complete",
      [],
    );
  const write = (body: string) =>
    writeSingleUpload(
      app,
      principal,
      created.id,
      created.capability,
      capabilities,
      new Blob([body]).stream(),
      3,
    );
  await expect(complete()).rejects.toThrow(/content_pending/);
  await expect(write("ab")).rejects.toThrow(/invalid_length/);
  expect(await env.BLOBS.head(`u/${f.ids.user}/b/${created.id}_blob`)).toBeNull();
  await expect(write("abc")).rejects.toThrow(/content_pending/);
});
