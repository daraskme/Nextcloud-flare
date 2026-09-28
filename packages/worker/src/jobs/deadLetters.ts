import { assertExists, primary } from "../db/primary";
import {
  acquireGlobalMutation,
  commitGlobalMutation,
  type GlobalMutationSource,
} from "../services/globalMutation";
import { type OutboxDelivery, outboxMessageId } from "./queue";

export interface DeadLetterDelivery extends OutboxDelivery {
  readonly id: string;
  readonly timestamp: Date;
}

/** Only the configured DLQ entry calls this. Never interpret its payload as an instruction. */
export async function handleDeadLetterBatch(
  env: GlobalMutationSource,
  batch: { readonly messages: readonly DeadLetterDelivery[] },
): Promise<{ acked: number; retried: number }> {
  const deadline = Date.now() + 25_000;
  let acked = 0,
    retried = 0;
  for (const message of batch.messages) {
    try {
      const sentAt = message.timestamp.getTime();
      if (
        Date.now() >= deadline ||
        typeof message.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(message.id) ||
        !Number.isSafeInteger(sentAt) ||
        sentAt < 0
      )
        throw new Error("invalid_dead_letter_envelope");
      const outboxId = outboxMessageId(message.body);
      const receipt = () =>
        primary(env.DB)
          .prepare(
            "SELECT 1 AS ok FROM queue_dead_letters WHERE message_id=? AND outbox_id IS ? AND sent_at=?",
          )
          .bind(message.id, outboxId, sentAt)
          .first<number>("ok");
      if ((await receipt()) !== 1) {
        const admission = await acquireGlobalMutation(env, "queue.dead-letter", deadline);
        if (Date.now() >= deadline) throw new Error("dead_letter_budget");
        await commitGlobalMutation(env.DB, admission, [
          assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
            admission.epoch,
          ]),
          {
            sql: `INSERT INTO queue_dead_letters(message_id,outbox_id,sent_at,received_at,epoch)
              VALUES(?,?,?,strftime('%s','now')*1000,?) ON CONFLICT(message_id) DO NOTHING`,
            values: [message.id, outboxId, sentAt, admission.epoch],
          },
          assertExists(
            "SELECT 1 FROM queue_dead_letters WHERE message_id=? AND outbox_id IS ? AND sent_at=?",
            [message.id, outboxId, sentAt],
          ),
        ]);
      }
      // This ACK proves only that the failed delivery is recorded, including malformed bodies.
      message.ack();
      acked++;
      continue;
    } catch {
      // No raw payload in logs or storage. Unknown writes and envelope conflicts retain delivery.
    }
    message.retry();
    retried++;
  }
  return { acked, retried };
}
