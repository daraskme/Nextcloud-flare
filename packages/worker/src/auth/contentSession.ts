import { assertExists, type SqlStatement } from "../db/primary";
import type { Principal } from "./authorize";

export type ContentPurpose = "content" | "thumb" | "page" | "zip" | "track";

/** Append to the same D1 batch as the protected read or write. Target membership is a separate check. */
export function contentSessionAssertion(
  principal: Principal,
  sessionId: string,
  ticketId: string,
  purpose: ContentPurpose,
  share?: { readonly id: string; readonly version: number },
): SqlStatement {
  if (
    principal.kind === "service" ||
    ![sessionId, ticketId, principal.credential_id].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
    ) ||
    (share !== undefined &&
      (principal.kind === "link_share" ||
        typeof share.id !== "string" ||
        share.id.length === 0 ||
        share.id.length > 128 ||
        !Number.isSafeInteger(share.version) ||
        share.version < 1)) ||
    !["content", "thumb", "page", "zip", "track"].includes(purpose) ||
    !Number.isSafeInteger(principal.epoch) ||
    principal.epoch < 1
  )
    throw new Error("invalid_content_session");
  const userId = principal.kind === "link_share" ? null : principal.user_id;
  const shareId = principal.kind === "link_share" ? principal.share_id : (share?.id ?? null);
  const shareVersion =
    principal.kind === "link_share" ? principal.share_version : (share?.version ?? null);
  return assertExists(
    `SELECT 1 FROM content_sessions cs
      JOIN tickets t ON t.id=cs.ticket_id AND t.target_set_id=cs.target_set_id
        AND t.budget_id=cs.budget_id
        AND t.credential_id=cs.issued_by_credential_id AND t.epoch=cs.epoch
      JOIN target_sets ts ON ts.id=cs.target_set_id AND ts.credential_id=cs.issued_by_credential_id
        AND ts.epoch=cs.epoch
      JOIN budgets b ON b.id=cs.budget_id AND b.epoch=cs.epoch AND b.owner_id=ts.owner_id
      JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=cs.epoch
      WHERE cs.id=? AND t.id=? AND t.purpose=? AND cs.issued_by_credential_id=?
        AND cs.epoch=? AND cs.user_id IS ? AND cs.share_id IS ? AND cs.share_version IS ?
        AND cs.revoked_at IS NULL AND cs.expires_at>strftime('%s','now')*1000
        AND t.cancelled_at IS NULL AND t.expires_at>strftime('%s','now')*1000
        AND ts.expires_at>strftime('%s','now')*1000
        AND b.state='active' AND b.expires_at>strftime('%s','now')*1000
        AND b.user_id IS cs.user_id AND b.share_id IS cs.share_id
        AND (cs.share_id IS NOT NULL OR ts.owner_id=cs.user_id)
        AND (cs.share_id IS NULL OR EXISTS(
          SELECT 1 FROM shares sh WHERE sh.id=cs.share_id AND sh.version=cs.share_version
            AND sh.owner_id=ts.owner_id
            AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND ((cs.user_id IS NULL AND sh.kind='link') OR
              (cs.user_id IS NOT NULL AND sh.kind='internal'))
            AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')
            AND (cs.user_id IS NULL OR EXISTS(
              SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=cs.user_id
                AND g.version=sh.version AND g.disabled_at IS NULL))))`,
    [
      sessionId,
      ticketId,
      purpose,
      principal.credential_id,
      principal.epoch,
      userId,
      shareId,
      shareVersion,
    ],
  );
}
