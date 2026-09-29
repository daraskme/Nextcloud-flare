import type { DeadLetterRequeue } from "@next-cloud-flare/shared/deadLetters";
import { adminAccessAssertion, LIVE_ADMIN_ACCESS, requireAdminAccess } from "../auth/admin";
import type { AccessSession } from "../auth/sessions";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { copyAuthorityStatements } from "../jobs/copyClaim";
import { loadCopyJobManifest } from "../jobs/copyManifest";
import { imageRequestAuthority } from "../jobs/imageRequestAuthority";
import { digestJson } from "../jobs/operations";
import { nodeEventAuthority, readOutboxEvent } from "../jobs/outboxAuthority";
import { OUTBOX_REQUEUE_ELIGIBLE } from "../jobs/outboxRequeue";
import {
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
} from "./accountMutation";

/** A durable administrative wake-up. Cron sends the existing ID through the normal producer. */
export async function requeueDeadLetter(
  env: Pick<Env, "DB" | "CONTROL">,
  session: AccessSession,
  outboxId: string,
  messageId: string,
  requestKey: string,
): Promise<DeadLetterRequeue> {
  const db = env.DB;
  await requireAdminAccess(db, session);
  const requeueId =
    "dlq_" + (await digestJson(["admin.dlq", session.user_id, session.credential_id, requestKey]));
  const receipt = async (): Promise<DeadLetterRequeue | null> => {
    const row = await primary(db)
      .prepare(`WITH administrator AS (${LIVE_ADMIN_ACCESS})
      SELECT d.requeue_id,d.message_id,d.outbox_id,d.requeue_actor_id,d.requeue_credential_id,d.requeue_epoch,d.requeued_at
      FROM administrator a LEFT JOIN queue_dead_letters d ON d.requeue_id=?4`)
      .bind(session.credential_id, session.user_id, session.epoch, requeueId)
      .first<{
        requeue_id: string | null;
        message_id: string;
        outbox_id: string;
        requeue_actor_id: string;
        requeue_credential_id: string;
        requeue_epoch: number;
        requeued_at: number;
      }>();
    if (!row) throw new Error("admin_access_required");
    if (row.requeue_id === null) return null;
    if (
      row.message_id !== messageId ||
      row.outbox_id !== outboxId ||
      row.requeue_actor_id !== session.user_id ||
      row.requeue_credential_id !== session.credential_id
    )
      throw new Error("requeue_key_conflict");
    return {
      messageId,
      outboxId,
      requeueId,
      requeuedAt: row.requeued_at,
      epoch: row.requeue_epoch,
    };
  };
  const existing = await receipt();
  if (existing) return existing;
  const observation = await primary(db)
    .prepare("SELECT requeue_id FROM queue_dead_letters WHERE message_id=? AND outbox_id=?")
    .bind(messageId, outboxId)
    .first<{ requeue_id: string | null }>();
  if (!observation) throw new Error("dead_letter_not_found");
  if (observation.requeue_id !== null) throw new Error("dead_letter_already_requeued");
  const eligible = () =>
    primary(db).prepare(OUTBOX_REQUEUE_ELIGIBLE).bind(outboxId, session.epoch).first();
  if (!(await eligible())) throw new Error("requeue_unavailable");
  const event = await readOutboxEvent(db, outboxId);
  if (!event) throw new Error("dead_letter_not_found");
  let authority: SqlStatement[];
  try {
    if (event.kind === "copy.requested") {
      const { plan } = await loadCopyJobManifest(db, event.payload_ref);
      authority = await copyAuthorityStatements(db, plan);
      authority.push(
        assertExists("SELECT 1 FROM copy_job_manifests WHERE job_id=? AND sha256=?", [
          event.payload_ref,
          plan.digest,
        ]),
      );
    } else if (event.kind === "image.requested") {
      const saved = await imageRequestAuthority(db, event);
      if (!saved) throw new Error("original_authority_unavailable");
      authority = saved;
    } else {
      const statements = await nodeEventAuthority(db, event);
      if (!statements) throw new Error("original_authority_unavailable");
      if (
        !(await primary(db)
          .prepare("SELECT 1 FROM operation_steps WHERE op_id=? AND kind='node' AND affected_id=?")
          .bind(event.op_id, event.payload_ref)
          .first())
      )
        throw new Error("original_step_unavailable");
      authority = [
        ...statements,
        assertExists(
          "SELECT 1 FROM operation_steps WHERE op_id=? AND kind='node' AND affected_id=?",
          [event.op_id, event.payload_ref],
        ),
      ];
    }
  } catch {
    throw new Error("requeue_unavailable");
  }
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "queue.requeue",
  );
  try {
    await commitAccountMutation(db, admission, session.user_id, [
      adminAccessAssertion(session),
      ...authority,
      assertExists(OUTBOX_REQUEUE_ELIGIBLE, [outboxId, session.epoch]),
      assertExists(
        "SELECT 1 FROM outbox b JOIN operations o ON o.op_id=b.op_id WHERE b.outbox_id=? AND b.op_id=? AND b.kind=? AND b.payload_ref=? AND o.kind=? AND o.operands_json=? AND o.result_json IS ?",
        [
          outboxId,
          event.op_id,
          event.kind,
          event.payload_ref,
          event.op_kind,
          event.operands_json,
          event.result_json,
        ],
      ),
      {
        sql: "UPDATE outbox SET state='pending',dispatch_token=NULL,dispatch_expires_at=NULL,updated_at=MAX(updated_at,strftime('%s','now')*1000) WHERE outbox_id=?",
        values: [outboxId],
      },
      assertOneChange,
      {
        sql: "INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) SELECT ?,?,?, 'admin.dlq',message_id,MAX(received_at,strftime('%s','now')*1000) FROM queue_dead_letters WHERE message_id=? AND outbox_id=? AND requeue_id IS NULL",
        values: [requeueId, event.op_id, session.user_id, messageId, outboxId],
      },
      assertOneChange,
      {
        sql: "UPDATE queue_dead_letters SET requeue_id=?,requeue_actor_id=?,requeue_credential_id=?,requeue_epoch=?,requeued_at=(SELECT created_at FROM activity WHERE id=?) WHERE message_id=? AND outbox_id=? AND requeue_id IS NULL",
        values: [
          requeueId,
          session.user_id,
          session.credential_id,
          session.epoch,
          requeueId,
          messageId,
          outboxId,
        ],
      },
      assertOneChange,
    ]);
  } catch (error) {
    const saved = await receipt();
    if (saved) return saved;
    const current = await primary(db)
      .prepare("SELECT requeue_id FROM queue_dead_letters WHERE message_id=?")
      .bind(messageId)
      .first<string | null>("requeue_id");
    if (current) throw new Error("dead_letter_already_requeued");
    throw new MutationUnavailableError({ cause: error });
  }
  const saved = await receipt();
  if (!saved) throw new MutationUnavailableError();
  return saved;
}
