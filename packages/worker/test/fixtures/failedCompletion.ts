import { env } from "cloudflare:workers";
import type { SystemMutationAdmission } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { uploadRow } from "../../src/services/uploads/access";
import { settleFailedCompletion } from "../../src/services/uploads/failedCompletion";
import { foundationFixture } from "./foundation";
import { acquireSystemMutation, mutationEnv } from "./mutationAdmission";

export const failedCompletionPrefix = "system:upload.complete-failed:";
export const completionModes = ["single", "multipart"] as const;
export async function failedCompletionFixture(
  mode: (typeof completionModes)[number],
  epoch = 1,
  options: {
    state?: "failed" | "claimed" | "committed";
    objectProof?: boolean;
    storage?: boolean;
  } = {},
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000),
    actor = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...f.statements, ...actor.statements]);
  const id = "up_" + (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""),
    blob = id + "_blob",
    reservation = id + "_reservation",
    op = crypto.randomUUID(),
    permit = crypto.randomUUID(),
    expires = Date.now() + 60000;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,?,1,'released')",
      values: [permit, f.ids.space, epoch],
    },
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
        permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,created_at,updated_at)
        VALUES(?,'user',?,?,?,'upload.complete',?,'operation-digest',?,?,1,1,10,?,1,1)`,
      values: [
        op,
        actor.ids.user,
        actor.ids.credential,
        f.ids.space,
        options.state ?? "failed",
        epoch,
        permit,
        JSON.stringify({ parentId: f.ids.folder, uploadId: id }),
      ],
    },
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,?)",
      values: [reservation, f.ids.user, expires, epoch],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,content_etag,r2_etag,state,created_at) VALUES(?,?,?,3,?,'content','object-etag','staging',1)",
      values: [
        blob,
        f.ids.user,
        `u/${f.ids.user}/b/${blob}`,
        mode === "single" ? "a".repeat(64) : null,
      ],
    },
    ...(options.storage === false
      ? []
      : [
          {
            sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'object-etag',1)",
            values: [blob],
          },
        ]),
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
        capability_hash,epoch,accept_parts,in_flight,created_at,expires_at,last_progress_at,
        upload_name,request_digest,capability_kid,write_attempt_id,write_lease_expires_at,completion_op_id,
        r2_upload_id,part_bytes,part_count,multipart_ledger_id,multipart_complete_attempt,multipart_complete_lease,multipart_object_etag)
        VALUES(?,?,?,?,?,?,?,?,'completing',3,'cap',?,0,0,1,?,1,'failed.bin','upload-digest','test','write',1,?,?,?,?,?,?,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        actor.ids.credential,
        reservation,
        mode,
        epoch,
        expires,
        op,
        mode === "multipart" ? "r2-upload" : null,
        mode === "multipart" ? 8388608 : null,
        mode === "multipart" ? 1 : null,
        mode === "multipart" ? "ledger" : null,
        mode === "multipart" ? "complete-attempt" : null,
        mode === "multipart" ? 1 : null,
        mode === "multipart" && options.objectProof !== false ? "object-etag" : null,
      ],
    },
  ]);
  const row = (await uploadRow(env.DB, id))!;
  const permits: string[] = [];
  const configure = (
    effect?: (grant: SystemMutationAdmission) => Promise<void>,
    db = env.DB,
    unavailable = false,
  ): SystemMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: async (r) => {
        permits.push(r.permitId);
        if (unavailable) throw new Error("unavailable");
        const grant = await acquireSystemMutation(r);
        await effect?.(grant);
        return grant;
      },
    },
  });
  const snapshot = () =>
    env.DB.prepare(`SELECT u.state,u.cleanup_pending,b.state AS blob_state,r.state AS reservation_state,
    owner.reserved_bytes,owner.physical_bytes FROM uploads u JOIN blobs b ON b.id=u.blob_id
    JOIN reservations r ON r.id=u.reservation_id JOIN users owner ON owner.id=u.owner_id WHERE u.id=?`)
      .bind(id)
      .first();
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
    )
      .bind(permits.at(-1) ?? "")
      .first();
  return {
    ...f,
    actor,
    id,
    blob,
    reservation,
    op,
    row,
    mode,
    permits,
    configure,
    snapshot,
    receipt,
    run: (source = configure()) => settleFailedCompletion(source, row, op),
  };
}
