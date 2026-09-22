import { consumeOutbox } from "./consumeOutbox";

export interface OutboxDelivery {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface OutboxBatch {
  readonly messages: readonly OutboxDelivery[];
}

function outboxId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "outboxId") return null;
  const id = (body as { outboxId?: unknown }).outboxId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Call only after ControlDO admission. Cloudflare moves exhausted retries to the configured DLQ. */
export async function handleOutboxBatch(
  db: D1Database,
  batch: OutboxBatch,
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  for (const message of batch.messages) {
    try {
      const id = outboxId(message.body);
      const result = id ? await consumeOutbox(db, id) : "retry";
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
