import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { expect } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import type { Env } from "../../src/env";
import { abortMultipartUpload, abortSingleUpload } from "../../src/services/uploads/abort";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload, reserveMultipartUpload } from "../../src/services/uploads/create";
import { createMultipartUpload, writeMultipartPart } from "../../src/services/uploads/multipart";
import { completeMultipartUpload } from "../../src/services/uploads/multipartComplete";
import { foundationFixture } from "./foundation";
import { acquireMutation } from "./mutationAdmission";
import { admitted } from "./uploadEnv";

export const actions = [
  "single-start",
  "single-recover",
  "single-verify",
  "multipart-start",
  "multipart-complete",
] as const;
export type Action = (typeof actions)[number];
export const settlementActions = ["single-abort", "multipart-abort", "multipart-verify"] as const;
export type SettlementAction = (typeof settlementActions)[number];
const objects = new Set<string>();
const handles: R2MultipartUpload[] = [];
const stream = () => new Blob(["abc"]).stream();
export async function cleanupTransferObjects() {
  for (const handle of handles) await handle.abort().catch(() => {});
  handles.length = 0;
  if (objects.size) await env.BLOBS.delete([...objects]);
  objects.clear();
}

export async function transferFixture(
  action: Action | SettlementAction,
  epoch = 1,
  realControl = false,
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(
    env.DB,
    f.statements.map((statement) =>
      statement.sql.startsWith("INSERT INTO sessions")
        ? {
            sql: statement.sql.replace("?,1,?,?,?)", "?,?,?,?,?)"),
            values: [...statement.values!.slice(0, 3), epoch, ...statement.values!.slice(3)],
          }
        : statement,
    ),
  );
  const capabilities = new UploadCapabilities(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const input = {
    principal: {
      kind: "user" as const,
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch,
    },
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "transfer.txt",
    declaredSize: 3,
  };
  const calls = { put: 0, get: 0, head: 0, create: 0, complete: 0 };
  let losePut = false;
  const bucket = new Proxy(env.BLOBS, {
    get(target, field) {
      if (field === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          calls.put++;
          objects.add(args[0]);
          const value = await target.put(...args);
          if (losePut) throw new Error("prepared_put_ack_lost");
          return value;
        };
      if (field === "get" || field === "head")
        return (...args: unknown[]) => {
          calls[field]++;
          return Reflect.apply(target[field], target, args);
        };
      if (field === "createMultipartUpload")
        return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
          calls.create++;
          objects.add(args[0]);
          const result = await target.createMultipartUpload(...args);
          handles.push(result);
          return result;
        };
      if (field === "resumeMultipartUpload")
        return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
          const handle = target.resumeMultipartUpload(...args);
          return new Proxy(handle, {
            get(multipart, key) {
              const value = Reflect.get(multipart, key);
              if (key === "complete")
                return (...parameters: unknown[]) => {
                  calls.complete++;
                  return Reflect.apply(multipart.complete, multipart, parameters);
                };
              return typeof value === "function" ? value.bind(multipart) : value;
            },
          });
        };
      const value = Reflect.get(target, field);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const configure = (
    acquire = (request: MutationRequest) => acquireMutation(request),
    db = env.DB,
  ) => {
    const app = realControl ? { ...env, DB: db } : admitted(db, epoch);
    app.APP_ORIGIN = "https://app.invalid";
    app.BLOBS = bucket;
    app.CONTROL = {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: acquire,
        status: realControl
          ? () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status()
          : async () => ({ epoch, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"];
    return app;
  };
  const app = configure(
    realControl
      ? (request) => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).acquireMutation(request)
      : undefined,
  );
  const single = action.startsWith("single");
  const created = await (single ? createSingleUpload : reserveMultipartUpload)(
    app,
    input,
    capabilities,
  );
  if (action === "single-recover") {
    losePut = true;
    await expect(
      writeSingleUpload(
        app,
        input.principal,
        created.id,
        created.capability,
        capabilities,
        stream(),
        3,
      ),
    ).rejects.toThrow("prepared_put_ack_lost");
    losePut = false;
  }
  if (action === "multipart-complete" || action === "multipart-verify") {
    await createMultipartUpload(app, input, capabilities);
    await writeMultipartPart(
      app,
      input.principal,
      created.id,
      created.capability,
      capabilities,
      1,
      "first",
      stream(),
      3,
    );
  }
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
  const baseline = await env.DB.prepare(
    "SELECT MAX(seq) AS n FROM mutation_admissions",
  ).first<number>("n");
  const run = (configured = configure(), body = stream()) =>
    action === "single-abort" || action === "multipart-abort"
      ? (action === "single-abort" ? abortSingleUpload : abortMultipartUpload)(
          configured,
          input.principal,
          created.id,
          created.capability,
          capabilities,
        )
      : action === "multipart-start"
        ? createMultipartUpload(configured, input, capabilities)
        : action === "multipart-complete" || action === "multipart-verify"
          ? completeMultipartUpload(
              configured,
              input.principal,
              created.id,
              created.capability,
              capabilities,
              "complete",
              [],
            )
          : writeSingleUpload(
              configured,
              input.principal,
              created.id,
              created.capability,
              capabilities,
              body,
              3,
            );
  const row = () =>
    env.DB.prepare(
      "SELECT u.state,u.write_attempt_id,u.multipart_complete_attempt,u.r2_upload_id,u.data_calls,u.control_calls,b.sha256_verified FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE u.id=?",
    )
      .bind(created.id)
      .first();
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at FROM mutation_admissions WHERE seq>? AND space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(baseline, f.ids.space, "upload." + action + ":%")
      .all()
      .then((r) => r.results);
  const counters = () =>
    env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first();
  return { f, action, input, capabilities, created, calls, configure, run, row, receipt, counters };
}
