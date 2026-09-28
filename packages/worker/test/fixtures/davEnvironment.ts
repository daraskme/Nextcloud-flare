import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { acquireMutation, mutationEnv } from "./mutationAdmission";

export function admittedDavEnv(overloaded = false): Env {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: overloaded
          ? async () => {
              throw new Error("queue_full");
            }
          : acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit() {
        return { success: true };
      },
    } as RateLimit,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const stub = env.LOCKS.get(id);
        const invoke = async <T>(callback: (instance: LockDO) => Promise<T>): Promise<T> => {
          const result = await runInDurableObject(stub, async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_error",
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
          acquireTrash: (request: Parameters<LockDO["acquireTrash"]>[0]) =>
            invoke((lock) => lock.acquireTrash(request)),
          acquireMove: (request: Parameters<LockDO["acquireMove"]>[0]) =>
            invoke((lock) => lock.acquireMove(request)),
          acquireCopy: (request: Parameters<LockDO["acquireCopy"]>[0]) =>
            invoke((lock) => lock.acquireCopy(request)),
          createDavLock: (request: Parameters<LockDO["createDavLock"]>[0]) =>
            invoke((lock) => lock.createDavLock(request)),
          refreshDavLock: (request: Parameters<LockDO["refreshDavLock"]>[0]) =>
            invoke((lock) => lock.refreshDavLock(request)),
          unlockDavLock: (request: Parameters<LockDO["unlockDavLock"]>[0]) =>
            invoke((lock) => lock.unlockDavLock(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}
