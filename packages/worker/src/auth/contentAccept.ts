import { base64url } from "jose";
import { assertExists, atomicBatch } from "../db/primary";
import { ContentTokens } from "./contentTokens";

export interface AcceptedContentSession {
  readonly sessionId: string;
  readonly setCookie: string;
  readonly expiresAt: number;
  readonly budgetId: string;
}

/** Redeem a signed ticket against current D1 rows; cookie creation alone grants no blob access. */
export async function acceptContentTicket(
  db: D1Database,
  tokens: ContentTokens,
  ticket: string,
): Promise<AcceptedContentSession> {
  const claims = await tokens.verifyTicket(ticket);
  const issuedAt = tokens.now();
  const expiresAt = claims.exp * 1000;
  const maxAge = Math.floor((expiresAt - issuedAt) / 1000);
  if (!Number.isSafeInteger(issuedAt) || maxAge < 1 || maxAge > 600)
    throw new Error("content_ticket_rejected");
  const sessionId = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const setCookie = await tokens.issueCookie(sessionId, maxAge);
  await atomicBatch(db, [
    assertExists(
      `SELECT 1 FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id
        JOIN budgets b ON b.id=t.budget_id AND b.owner_id=ts.owner_id
        JOIN credentials c ON c.id=t.credential_id
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=t.epoch AND ctl.maintenance=0
        WHERE t.id=? AND t.credential_id=? AND t.target_set_id=? AND t.budget_id=?
          AND t.purpose=? AND t.epoch=? AND t.issued_at>=? AND t.issued_at<?
          AND t.expires_at>=? AND t.cancelled_at IS NULL
          AND ts.credential_id=t.credential_id AND ts.epoch=t.epoch
          AND ts.manifest_hash=? AND ts.expires_at>=?
          AND b.epoch=t.epoch AND b.state='active' AND b.expires_at>=?
          AND b.user_id IS ? AND b.share_id IS ?
          AND (
            (? IS NOT NULL AND c.kind='access' AND EXISTS(
              SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
              WHERE s.id=c.session_id AND s.kind='access' AND s.user_id=?
                AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.epoch=t.epoch
                AND s.expires_at>?))
            OR (? IS NOT NULL AND c.kind='app_password' AND EXISTS(
              SELECT 1 FROM app_passwords ap JOIN users u ON u.id=ap.user_id
              WHERE ap.id=c.app_password_id AND ap.user_id=? AND u.disabled_at IS NULL
                AND ap.revoked_at IS NULL AND ap.expires_at>?))
            OR (? IS NULL AND c.kind='share' AND EXISTS(
              SELECT 1 FROM share_sessions ss JOIN shares sh ON sh.id=ss.share_id
              JOIN users owner ON owner.id=sh.owner_id
              WHERE ss.id=c.share_session_id AND ss.share_id=? AND ss.share_version=?
                AND ss.user_id IS NULL AND ss.epoch=t.epoch AND ss.revoked_at IS NULL
                AND ss.expires_at>? AND sh.kind='link' AND sh.version=ss.share_version
                AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
                AND (sh.expires_at IS NULL OR sh.expires_at>=?)
                AND sh.owner_id=ts.owner_id
                AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')))
          )
          AND (
            (? IS NULL AND ts.owner_id=?) OR
            (? IS NOT NULL AND EXISTS(
              SELECT 1 FROM shares sh WHERE sh.id=? AND sh.version=?
                AND sh.owner_id=ts.owner_id AND sh.disabled_at IS NULL
                AND (sh.expires_at IS NULL OR sh.expires_at>=?)
                AND ((? IS NULL AND sh.kind='link') OR
                  (? IS NOT NULL AND sh.kind='internal' AND EXISTS(
                    SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=?
                      AND g.version=sh.version AND g.disabled_at IS NULL)))
                AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')))
          )`,
      [
        claims.ticket_id,
        claims.credential_id,
        claims.target_set_id,
        claims.budget_id,
        claims.purpose,
        claims.epoch,
        claims.iat * 1000,
        (claims.iat + 1) * 1000,
        expiresAt,
        claims.target_set_hash,
        expiresAt,
        expiresAt,
        claims.user_id,
        claims.share_id,
        claims.user_id,
        claims.user_id,
        issuedAt,
        claims.user_id,
        claims.user_id,
        issuedAt,
        claims.user_id,
        claims.share_id,
        claims.share_version,
        issuedAt,
        expiresAt,
        claims.share_id,
        claims.user_id,
        claims.share_id,
        claims.share_id,
        claims.share_version,
        expiresAt,
        claims.user_id,
        claims.user_id,
        claims.user_id,
      ],
    ),
    {
      sql: `INSERT INTO content_sessions
        (id,user_id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,ticket_id,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      values: [
        sessionId,
        claims.user_id,
        claims.share_id,
        claims.share_version,
        claims.credential_id,
        claims.target_set_id,
        claims.budget_id,
        claims.ticket_id,
        claims.epoch,
        issuedAt,
        expiresAt,
      ],
    },
  ]);
  return Object.freeze({ sessionId, setCookie, expiresAt, budgetId: claims.budget_id });
}
