import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LockDO } from "../../src/do/LockDO";
import { UploadDO } from "../../src/do/UploadDO";
import type { Env } from "../../src/env";
import { acquireMutation } from "./mutationAdmission";

/** Explicit test-only admission with real DO storage/D1. Production ControlDO stays closed. */
export function admitted(db = env.DB, epoch = 1, maintenance = false): Env {
  const app: Env = {
    ...env,
    DB: db,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation,
        status: async () => ({ epoch, maintenance, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  app.UPLOADS = {
    idFromName: env.UPLOADS.idFromName.bind(env.UPLOADS),
    get(id: DurableObjectId) {
      const invoke = async <T>(callback: (upload: UploadDO) => Promise<T>) => {
        const result = await runInDurableObject(env.UPLOADS.get(id), async (_, state) => {
          try {
            return { ok: true as const, value: await callback(new UploadDO(state, app)) };
          } catch (error) {
            return {
              ok: false as const,
              message: error instanceof Error ? error.message : "upload_failed",
            };
          }
        });
        if (!result.ok) throw new Error(result.message);
        return result.value;
      };
      return {
        status: (r: Parameters<UploadDO["status"]>[0]) => invoke((upload) => upload.status(r)),
        claimPart: (r: Parameters<UploadDO["claimPart"]>[0]) =>
          invoke((upload) => upload.claimPart(r)),
        settlePart: (r: Parameters<UploadDO["settlePart"]>[0]) =>
          invoke((upload) => upload.settlePart(r)),
        completedParts: (r: Parameters<UploadDO["completedParts"]>[0]) =>
          invoke((upload) => upload.completedParts(r)),
        beginComplete: (r: Parameters<UploadDO["beginComplete"]>[0]) =>
          invoke((upload) => upload.beginComplete(r)),
        acknowledgeCompletion: (r: Parameters<UploadDO["acknowledgeCompletion"]>[0]) =>
          invoke((upload) => upload.acknowledgeCompletion(r)),
        requestAbort: (r: Parameters<UploadDO["requestAbort"]>[0]) =>
          invoke((upload) => upload.requestAbort(r)),
      };
    },
  } as unknown as Env["UPLOADS"];
  app.LOCKS = {
    idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
    get(id: DurableObjectId) {
      const invoke = async <T>(callback: (lock: LockDO) => Promise<T>) => {
        const result = await runInDurableObject(env.LOCKS.get(id), async (_, state) => {
          try {
            return { ok: true as const, value: await callback(new LockDO(state, app)) };
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
        acquireCreate: (r: Parameters<LockDO["acquireCreate"]>[0]) =>
          invoke((lock) => lock.acquireCreate(r)),
        acquireNodeWrite: (r: Parameters<LockDO["acquireNodeWrite"]>[0]) =>
          invoke((lock) => lock.acquireNodeWrite(r)),
        release: (id: string, permit: Parameters<LockDO["release"]>[1]) =>
          invoke((lock) => lock.release(id, permit)),
      };
    },
  } as unknown as Env["LOCKS"];
  return app;
}

export function injectBatch(
  predicate: (sql: string) => boolean,
  effect: () => Promise<void>,
  after: boolean,
): D1Database {
  const queries = new WeakMap<object, string>();
  let injected = false;
  return {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      return new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              queries.set(bound, query);
              return bound;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches = !injected && statements.some((s) => predicate(queries.get(s) ?? ""));
      if (matches) {
        injected = true;
        if (!after) await effect();
      }
      const result = await env.DB.batch(statements);
      if (matches && after) await effect();
      return result;
    },
  } as D1Database;
}
