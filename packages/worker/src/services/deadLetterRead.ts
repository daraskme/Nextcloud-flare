import type { DeadLetter, DeadLetterPage } from "@next-cloud-flare/shared/deadLetters";
import { LIVE_ADMIN_ACCESS } from "../auth/admin";
import type { ListCursorClaims, ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import { primary } from "../db/primary";

const PAGE_SIZE = 50;

/** Administrator scope exposes delivery metadata only, never stored operands or file metadata. */
export async function listDeadLetters(
  db: D1Database,
  session: AccessSession,
  cursors: ListCursorTokens,
  cursor?: string,
): Promise<DeadLetterPage> {
  let after: ListCursorClaims | undefined;
  if (cursor !== undefined) {
    after = await cursors.verify(cursor);
    if (
      after.aud !== "admin-dlq" ||
      after.scopeId !== "dlq" ||
      after.generation !== 1 ||
      after.userId !== session.user_id ||
      after.credentialId !== session.credential_id ||
      after.epoch !== session.epoch
    )
      throw new Error("invalid_list_cursor");
  }
  // The sentinel distinguishes an authorized empty list from a revoked/demoted session.
  // This same D1 statement checks live authority while reading the page.
  const result = await primary(db)
    .prepare(`WITH administrator AS (${LIVE_ADMIN_ACCESS}), page AS (
    SELECT * FROM queue_dead_letters WHERE (received_at,message_id)<(?4,?5)
    ORDER BY received_at DESC,message_id DESC LIMIT 51
  ) SELECT d.message_id AS messageId,d.outbox_id AS outboxId,d.sent_at AS sentAt,
    d.received_at AS receivedAt,d.epoch AS recordedEpoch,
    CASE WHEN b.kind IN ('media.requested','image.requested','copy.requested','node.created','node.updated','node.trashed','node.restored','node.purged','node.renamed')
      THEN b.kind WHEN b.outbox_id IS NOT NULL THEN 'unknown' END AS eventKind,
    b.state AS eventState,b.epoch AS eventEpoch,j.id AS jobId,j.state AS jobState,
    d.requeue_id AS requeueId,d.requeued_at AS requeuedAt
    FROM administrator a LEFT JOIN page d ON 1 LEFT JOIN outbox b ON b.outbox_id=d.outbox_id
    LEFT JOIN bulk_jobs j ON b.kind='copy.requested' AND j.id=b.payload_ref AND j.op_id=b.op_id AND j.kind='node.copy'
    ORDER BY d.received_at DESC,d.message_id DESC`)
    .bind(
      session.credential_id,
      session.user_id,
      session.epoch,
      after?.lastSort ?? Number.MAX_SAFE_INTEGER,
      after?.lastId ?? "z",
    )
    .all<DeadLetter>();
  if (!result.results.length) throw new Error("admin_access_required");
  const rows = result.results.filter((row) => row.messageId !== null);
  const items = rows.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  const nextCursor =
    rows.length > PAGE_SIZE && last
      ? await cursors.issue({
          aud: "admin-dlq",
          scopeId: "dlq",
          generation: 1,
          userId: session.user_id,
          credentialId: session.credential_id,
          epoch: session.epoch,
          lastSort: last.receivedAt,
          lastId: last.messageId,
        })
      : null;
  return { items, nextCursor };
}
