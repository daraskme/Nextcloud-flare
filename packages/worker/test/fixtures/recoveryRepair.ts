import { env } from "cloudflare:workers";
import type { MutationAdmission } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import {
  failStaleRecoveryOutbox,
  rebuildRecoverySearchFts,
  releaseStaleRecoveryReservations,
} from "../../src/do/recoveryAudit";
import type { InventoryMutationSource } from "../../src/services/globalMutation";
import { foundationFixture } from "./foundation";
import { acquireGlobalMutation, acquireSystemMutation, mutationEnv } from "./mutationAdmission";

export const repairKinds = ["reservation-release", "outbox-fail", "fts-rebuild"] as const;
export type RepairKind = (typeof repairKinds)[number];
export type Foundation = ReturnType<typeof foundationFixture>;
export async function resetRecoveryRepairs(admin: Foundation, epoch = 2) {
  await env.DB.prepare(
    "UPDATE control SET epoch=?,maintenance=1,gc_paused=1,bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(epoch, admin.ids.user)
    .run();
  await atomicBatch(env.DB, [
    { sql: "UPDATE users SET disabled_at=NULL" },
    { sql: "DELETE FROM uploads" },
    { sql: "UPDATE reservations SET state='released' WHERE state='reserved'" },
    { sql: "DELETE FROM reservations" },
    { sql: "DELETE FROM outbox" },
    { sql: "DELETE FROM operation_steps" },
    { sql: "DELETE FROM operations" },
    { sql: "DELETE FROM permits" },
    { sql: "DELETE FROM search_index" },
    { sql: "INSERT INTO search_fts(search_fts) VALUES('rebuild')" },
  ]);
}
export async function recoveryRepairFixture(kind: RepairKind, actor: Foundation, epoch = 2) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = crypto.randomUUID(),
    opId = crypto.randomUUID(),
    permitId = crypto.randomUUID();
  if (kind === "reservation-release")
    await env.DB.prepare(
      "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,?)",
    )
      .bind(id, f.ids.user, Date.now() + 60000, epoch - 1)
      .run();
  if (kind === "outbox-fail")
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,?,1,'released')",
        values: [permitId, f.ids.space, epoch - 1],
      },
      {
        sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user',?,?,?,'node.create','committed','digest',?,?,1,1,0,1,1)`,
        values: [opId, actor.ids.user, actor.ids.credential, f.ids.space, epoch - 1, permitId],
      },
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
        values: [opId, f.ids.folder],
      },
      {
        sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',?,1,1)",
        values: [id, opId, f.ids.folder, epoch - 1],
      },
    ]);
  if (kind === "fts-rebuild")
    await env.DB.prepare(
      "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'repairneedle','re pa','v1',1)",
    )
      .bind(f.ids.folder, f.ids.space)
      .run();
  const prefix = (kind === "fts-rebuild" ? "global:" : "system:") + "recovery." + kind + ":";
  const permits: string[] = [];
  const configure = (
    effect?: (admission: MutationAdmission<string | null>) => Promise<void>,
    db = env.DB,
    unavailable = false,
  ): InventoryMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireGlobalMutation: async (r) => {
        permits.push(r.permitId);
        if (unavailable) throw new Error("queue_full");
        const grant = await acquireGlobalMutation(r);
        await effect?.(grant);
        return grant;
      },
      acquireSystemMutation: async (r) => {
        permits.push(r.permitId);
        if (unavailable) throw new Error("queue_full");
        const grant = await acquireSystemMutation(r);
        await effect?.(grant);
        return grant;
      },
    },
  });
  const run = (source = configure(), limit = 20) =>
    kind === "fts-rebuild"
      ? rebuildRecoverySearchFts(source, epoch)
      : kind === "outbox-fail"
        ? failStaleRecoveryOutbox(source, epoch, limit)
        : releaseStaleRecoveryReservations(source, epoch, limit);
  const read = () =>
    kind === "fts-rebuild"
      ? env.DB.prepare(
          "SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'repairneedle'",
        ).first("n")
      : env.DB.prepare(
          kind === "outbox-fail"
            ? "SELECT state FROM outbox WHERE outbox_id=?"
            : "SELECT state FROM reservations WHERE id=?",
        )
          .bind(id)
          .first("state");
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
    )
      .bind(permits.at(-1) ?? "")
      .first();
  const terminal = kind === "fts-rebuild" ? 1 : kind === "outbox-fail" ? "failed" : "released";
  const initial = kind === "fts-rebuild" ? 0 : kind === "outbox-fail" ? "pending" : "reserved";
  return {
    ...f,
    id,
    opId,
    kind,
    prefix,
    permits,
    configure,
    run,
    read,
    receipt,
    terminal,
    initial,
  };
}
