import type { Env } from "../env";
import type { SystemMutationSource } from "../services/systemMutation";
import { consumeOutbox } from "./consumeOutbox";
import { processTreeJob } from "./treeJobWorker";

export interface OutboxDelivery {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface OutboxBatch {
  readonly messages: readonly OutboxDelivery[];
}

function queuedId(body: unknown): { kind: "outbox" | "tree"; id: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1) return null;
  const id = (body as { outboxId?: unknown }).outboxId;
  if (fields[0] === "outboxId" && typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
    return { kind: "outbox", id };
  const treeJobId = (body as { treeJobId?: unknown }).treeJobId;
  return fields[0] === "treeJobId" &&
    typeof treeJobId === "string" &&
    /^job_[a-f0-9]{64}$/.test(treeJobId)
    ? { kind: "tree", id: treeJobId }
    : null;
}

/** Call only after ControlDO admission. Cloudflare moves exhausted retries to the configured DLQ. */
export async function handleOutboxBatch(
  env: SystemMutationSource & Partial<Pick<Env, "CONTROL">>,
  batch: OutboxBatch,
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  const deadline = Date.now() + 25_000;
  for (const message of batch.messages) {
    try {
      const queued = queuedId(message.body);
      const result =
        queued && Date.now() < deadline
          ? queued.kind === "outbox"
            ? await consumeOutbox(env, queued.id, deadline)
            : await processTreeJob(env, queued.id, deadline)
          : "retry";
      if (
        result === "completed" ||
        result === "failed" ||
        result === "progressed" ||
        result === "busy"
      ) {
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
