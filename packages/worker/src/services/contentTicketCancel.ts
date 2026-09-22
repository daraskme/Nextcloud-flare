import { type Principal } from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Cancel one ticket and every content session redeemed from it. Budgets may be shared by other tickets. */
export async function cancelContentTicket(
  db: D1Database,
  principal: Principal,
  ticketId: string,
): Promise<void> {
  if (principal.kind === "service" || !ID.test(ticketId))
    throw new Error("invalid_ticket_cancel_request");
  const now = Date.now();
  const userId = principal.kind === "link_share" ? null : principal.user_id;
  const shareId = principal.kind === "link_share" ? principal.share_id : null;
  const shareVersion = principal.kind === "link_share" ? principal.share_version : null;
  const authority = assertExists(
    `SELECT 1 FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id
      JOIN credentials c ON c.id=t.credential_id
      JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=t.epoch AND ctl.maintenance=0
      WHERE t.id=? AND t.credential_id=? AND t.epoch=? AND ts.credential_id=t.credential_id
        AND ts.epoch=t.epoch AND (
          (?='user' AND c.kind='access' AND EXISTS(
            SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.id=c.session_id AND s.kind='access' AND s.user_id=? AND s.epoch=t.epoch
              AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled_at IS NULL))
          OR (?='app_password' AND c.kind='app_password' AND EXISTS(
            SELECT 1 FROM app_passwords ap JOIN users u ON u.id=ap.user_id
            WHERE ap.id=c.app_password_id AND ap.user_id=? AND ap.revoked_at IS NULL
              AND ap.expires_at>? AND u.disabled_at IS NULL))
          OR (?='link_share' AND c.kind='share' AND EXISTS(
            SELECT 1 FROM share_sessions ss JOIN shares sh ON sh.id=ss.share_id
              JOIN users owner ON owner.id=sh.owner_id
            WHERE ss.id=c.share_session_id AND ss.share_id=? AND ss.share_version=?
              AND ss.epoch=t.epoch AND ss.revoked_at IS NULL AND ss.expires_at>?
              AND sh.kind='link' AND sh.version=ss.share_version
              AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL)))`,
    [
      ticketId,
      principal.credential_id,
      principal.epoch,
      principal.kind,
      userId,
      now,
      principal.kind,
      userId,
      now,
      principal.kind,
      shareId,
      shareVersion,
      now,
    ],
  );
  try {
    await atomicBatch(db, [
      authority,
      {
        sql: "UPDATE tickets SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?",
        values: [now, ticketId],
      },
      {
        sql: "UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE ticket_id=?",
        values: [now, ticketId],
      },
    ]);
  } catch (cause) {
    let row: { cancelled_at: number | null; live: number } | null;
    try {
      row = await primary(db)
        .prepare(`SELECT t.cancelled_at,
          (SELECT COUNT(*) FROM content_sessions cs WHERE cs.ticket_id=t.id AND cs.revoked_at IS NULL) AS live
          FROM tickets t WHERE t.id=? AND t.credential_id=? AND t.epoch=?`)
        .bind(ticketId, principal.credential_id, principal.epoch)
        .first();
    } catch {
      throw new Error("ticket_cancel_commit_unknown", { cause });
    }
    if (row?.cancelled_at !== null && row?.cancelled_at !== undefined && row.live === 0) return;
    throw cause;
  }
}
