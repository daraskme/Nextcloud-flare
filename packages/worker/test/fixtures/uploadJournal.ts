import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  MutationAdmission,
  MutationRequest,
  SystemMutationAdmission,
} from "../../src/db/mutationAdmission";
import { UploadDO } from "../../src/do/UploadDO";
import { MultipartLedger } from "../../src/do/uploadLedger";
import type { Env } from "../../src/env";
import { writeMultipartPart } from "../../src/services/uploads/multipart";
import { acquireMutation, acquireSystemMutation, mutationEnv } from "./mutationAdmission";
import { transferFixture } from "./uploadTransfer";

export const journalStages = ["init", "part", "stop", "lost"] as const;
export type JournalStage = (typeof journalStages)[number];
export async function journalFixture(
  stage: JournalStage,
  epoch = 1,
  control?: () => ReturnType<Env["CONTROL"]["get"]>,
) {
  const f = await transferFixture("multipart-start", epoch);
  const request = {
    uploadId: f.created.id,
    principal: f.input.principal,
    capability: f.created.capability,
  };
  const actual = env.UPLOADS.get(env.UPLOADS.idFromName(f.created.id));
  let parts = 0;
  const configure = (
    options: {
      db?: D1Database;
      acquire?: (r: MutationRequest) => Promise<MutationAdmission>;
      systemAcquire?: (r: MutationRequest) => Promise<SystemMutationAdmission>;
    } = {},
  ) => {
    const app = f.configure(
      options.acquire ?? (control ? (r) => control().acquireMutation(r) : acquireMutation),
      options.db ?? env.DB,
      options.systemAcquire ??
        (control ? (r) => control().acquireSystemMutation(r) : acquireSystemMutation),
    );
    const stub = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
    app.CONTROL = {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        ...stub,
        status: () =>
          control
            ? control().status()
            : mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      }),
    } as unknown as Env["CONTROL"];
    const bucket = app.BLOBS;
    app.BLOBS = new Proxy(bucket, {
      get(target, field) {
        if (field === "resumeMultipartUpload")
          return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
            const handle = target.resumeMultipartUpload(...args);
            return new Proxy(handle, {
              get(multipart, key) {
                if (key === "uploadPart")
                  return (...args: Parameters<R2MultipartUpload["uploadPart"]>) => {
                    parts++;
                    return multipart.uploadPart(...args);
                  };
                const value = Reflect.get(multipart, key);
                return typeof value === "function" ? value.bind(multipart) : value;
              },
            });
          };
        const value = Reflect.get(target, field);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return app;
  };
  if (stage !== "init") await f.run(configure());
  if (stage === "stop")
    await runInDurableObject(actual, (_instance, state) => {
      new MultipartLedger(state.storage).requestAbort(epoch, Date.now());
    });
  if (stage === "lost") {
    const app = configure();
    await app.UPLOADS.get(actual.id).claimPart({
      ...request,
      partNumber: 1,
      attemptId: "pending",
      bytes: 3,
    });
    await runInDurableObject(actual, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  }
  const baseline = (await env.DB.prepare(
    "SELECT MAX(seq) AS n FROM mutation_admissions",
  ).first<number>("n"))!;
  for (const key of Object.keys(f.calls) as (keyof typeof f.calls)[]) f.calls[key] = 0;
  const prefix =
    (stage === "stop" || stage === "lost" ? "system:" : "") +
    "upload.multipart-journal-" +
    (stage === "part" ? "mirror" : stage) +
    ":";
  const invoke = async (app: Env) => {
    if (stage === "init") return f.run(app);
    if (stage === "part")
      return writeMultipartPart(
        app,
        request.principal,
        request.uploadId,
        request.capability,
        f.capabilities,
        1,
        "journal-part",
        new Blob(["abc"]).stream(),
        3,
      );
    if (stage === "lost") return app.UPLOADS.get(actual.id).status(request);
    const result = await runInDurableObject(actual, async (_instance, state) => {
      try {
        await new UploadDO(state, app).alarm();
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : "alarm_failed",
        };
      }
    });
    if (!result.ok) throw new Error(result.message);
    return result;
  };
  const run = (app = configure()) =>
    invoke(app).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const row = () =>
    env.DB.prepare(
      "SELECT state,multipart_ledger_id,multipart_revision,in_flight,data_calls,data_bytes,cleanup_pending FROM uploads WHERE id=?",
    )
      .bind(f.created.id)
      .first();
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE seq>? AND space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(baseline, f.f.ids.space, prefix + "%")
      .all()
      .then((r) => r.results);
  const journal = () =>
    runInDurableObject(actual, async (_instance, state) => ({
      binding: state.storage.sql.exec("SELECT * FROM multipart_binding").toArray(),
      dirty: state.storage.sql.exec("SELECT * FROM multipart_dirty").toArray(),
      alarm: await state.storage.getAlarm(),
    }));
  const atGate = () => {
    let seen = 0;
    return (r: MutationRequest) =>
      r.permitId.startsWith(prefix) && ++seen === (stage === "part" ? 2 : 1);
  };
  return {
    ...f,
    stage,
    request,
    actual,
    prefix,
    configure,
    run,
    row,
    receipt,
    journal,
    atGate,
    parts: () => parts,
  };
}
