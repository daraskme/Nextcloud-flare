import { primary } from "../db/primary";
import { archiveIndexReadBudget } from "./archiveQueue";
import { consumeOutbox, type OutboxConsumerEnv } from "./consumeOutbox";

export interface OutboxDelivery {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface OutboxBatch {
  readonly messages: readonly OutboxDelivery[];
}

export function outboxMessageId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "outboxId") return null;
  const id = (body as { outboxId?: unknown }).outboxId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Call only after ControlDO admission. Cloudflare moves exhausted retries to the configured DLQ. */
export async function handleOutboxBatch(
  env: OutboxConsumerEnv,
  batch: OutboxBatch,
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  let nodeBatch = false;
  let copyBatch = false;
  const deadline = Date.now() + 25_000;
  const imageBudget = { reads: 0, bytes: 0 };
  const generationBudget = { transforms: 0 };
  const archiveBudget = archiveIndexReadBudget();
  for (const message of batch.messages) {
    try {
      const id = outboxMessageId(message.body);
      let result = "retry";
      if (id && Date.now() < deadline && !copyBatch) {
        const kind = await primary(env.DB)
          .prepare("SELECT kind FROM outbox WHERE outbox_id=?")
          .bind(id)
          .first<string>("kind");
        if (kind === "copy.requested") {
          // A copy's D1/native allowance belongs to this entire Worker invocation.
          // Never multiply it across deliveries, including terminal cleanup pages.
          copyBatch = true;
          if (!nodeBatch) result = await consumeOutbox(env, id, deadline);
        } else {
          nodeBatch = true;
          result = await consumeOutbox(
            env,
            id,
            deadline,
            imageBudget,
            generationBudget,
            archiveBudget,
          );
        }
      }
      if (result === "completed" || result === "failed") {
        message.ack();
        acked++;
        continue;
      }
    } catch {
      // An unknown D1 outcome is retried; only the durable terminal row authorizes ack.
    }
    message.retry();
    retried++;
  }
  return { acked, retried };
}
