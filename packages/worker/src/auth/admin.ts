import { assertExists, primary } from "../db/primary";
import type { AccessSession } from "./sessions";

/** Explicit administrator scope, independent of authority over another user's content. */
export const LIVE_ADMIN_ACCESS = `SELECT u.id FROM credentials c JOIN sessions s ON s.id=c.session_id JOIN users u ON u.id=s.user_id
  JOIN control ctl ON ctl.singleton=1 WHERE c.id=?1 AND c.kind='access' AND s.kind='access'
    AND u.id=?2 AND u.role='app_admin' AND u.disabled_at IS NULL AND s.revoked_at IS NULL
    AND s.expires_at>strftime('%s','now')*1000 AND s.epoch=?3 AND ctl.epoch=?3 AND ctl.maintenance=0`;
export function adminAccessAssertion(session: AccessSession) {
  return assertExists(LIVE_ADMIN_ACCESS, [session.credential_id, session.user_id, session.epoch]);
}
export async function requireAdminAccess(db: D1Database, session: AccessSession): Promise<void> {
  if (
    !(await primary(db)
      .prepare(LIVE_ADMIN_ACCESS)
      .bind(session.credential_id, session.user_id, session.epoch)
      .first())
  )
    throw new Error("admin_access_required");
}
