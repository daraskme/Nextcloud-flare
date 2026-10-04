import { type Principal } from "../auth/authorize";
import { assertExists, primary } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
  principalActor,
} from "./accountMutation";
import { removeZipPinStatements } from "./refs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Cancel one ticket and every content session redeemed from it. Budgets may be shared by other tickets. */
export async function cancelContentTicket(
  env: AccountMutationEnv,
  principal: Principal,
  ticketId: string,
): Promise<void> {
  if (principal.kind === "service" || !ID.test(ticketId))
    throw new Error("invalid_ticket_cancel_request");
  const db = env.DB;
  const now = Date.now();
  const userId = principal.kind === "link_share" ? null : principal.user_id;
  const shareId = principal.kind === "link_share" ? principal.share_id : null;
  const shareVersion = principal.kind === "link_share" ? principal.share_version : null;
  const authorityQuery = `SELECT ts.owner_id,t.target_set_id AS targetSetId,t.purpose
      FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id
      JOIN credentials c ON c.id=t.credential_id
      JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=t.epoch AND ctl.maintenance=0
      WHERE t.id=? AND t.credential_id=? AND t.epoch=? AND ts.credential_id=t.credential_id
        AND ts.epoch=t.epoch AND (
          (?='user' AND c.kind='access' AND EXISTS(
            SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.id=c.session_id AND s.kind='access' AND s.user_id=? AND s.epoch=t.epoch
              AND s.revoked_at IS NULL AND s.expires_at>MAX(?,strftime('%s','now')*1000) AND u.disabled_at IS NULL))
          OR (?='app_password' AND c.kind='app_password' AND EXISTS(
            SELECT 1 FROM app_passwords ap JOIN users u ON u.id=ap.user_id
            WHERE ap.id=c.app_password_id AND ap.user_id=? AND ap.revoked_at IS NULL
              AND ap.expires_at>MAX(?,strftime('%s','now')*1000) AND u.disabled_at IS NULL))
          OR (?='link_share' AND c.kind='share' AND EXISTS(
            SELECT 1 FROM share_sessions ss JOIN shares sh ON sh.id=ss.share_id
              JOIN users owner ON owner.id=sh.owner_id
            WHERE ss.id=c.share_session_id AND ss.share_id=? AND ss.share_version=?
              AND ss.epoch=t.epoch AND ss.revoked_at IS NULL AND ss.expires_at>MAX(?,strftime('%s','now')*1000)
              AND sh.kind='link' AND sh.version=ss.share_version
              AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL)))`;
  const authorityValues = [
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
  ];
  const ticket = await primary(db)
    .prepare(authorityQuery)
    .bind(...authorityValues)
    .first<{ owner_id: string; targetSetId: string; purpose: string }>();
  if (!ticket) throw new Error("invalid_ticket_cancel_request");
  const admission = await acquireAccountMutation(
    env,
    ticket.owner_id,
    principal.epoch,
    "content.cancel",
    principalActor(principal),
  );
  try {
    await commitAccountMutation(db, admission, ticket.owner_id, [
      assertExists(authorityQuery + " AND ts.owner_id=? AND t.target_set_id=? AND t.purpose=?", [
        ...authorityValues,
        ticket.owner_id,
        ticket.targetSetId,
        ticket.purpose,
      ]),
      {
        sql: "UPDATE tickets SET cancelled_at=COALESCE(cancelled_at,MAX(?,strftime('%s','now')*1000)) WHERE id=?",
        values: [now, ticketId],
      },
      {
        sql: "UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,MAX(?,strftime('%s','now')*1000)) WHERE ticket_id=?",
        values: [now, ticketId],
      },
      ...(ticket.purpose === "zip" ? removeZipPinStatements(ticket.targetSetId) : []),
    ]);
  } catch (cause) {
    throw new Error("ticket_cancel_commit_unknown", { cause });
  }
}
