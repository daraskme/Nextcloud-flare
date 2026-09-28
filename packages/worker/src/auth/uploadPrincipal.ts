import type { Principal } from "./authorize";
import { type SelectedShareRecord, storedPrincipal } from "./selectedShare";

export interface UploadAuthorityRecord extends SelectedShareRecord {
  readonly credential_id: string;
  readonly epoch: number;
  readonly link_share_id: string | null;
  readonly link_share_version: number | null;
}

/** A current cookie cannot substitute another link, version, or credential for a saved upload. */
export function uploadPrincipal(principal: Principal, row: UploadAuthorityRecord): Principal {
  if (
    principal.credential_id !== row.credential_id ||
    principal.epoch !== row.epoch ||
    (principal.kind === "link_share"
      ? row.link_share_id !== principal.share_id ||
        row.link_share_version !== principal.share_version
      : row.link_share_id !== null || row.link_share_version !== null)
  )
    throw new Error("upload_authorization_denied");
  return storedPrincipal(principal, row);
}

/** Historical publication proof, valid after revocation; it never grants a new transfer. */
export const UPLOAD_OPERATION_PRINCIPAL = `(((u.link_share_id IS NULL AND u.link_share_version IS NULL)
  AND (o.principal_kind='user' AND o.credential_version IS NULL)
  AND EXISTS(SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
    WHERE c.id=u.credential_id AND c.kind='access' AND s.user_id=o.principal_id))
  OR ((u.link_share_id IS NOT NULL AND u.link_share_version IS NOT NULL)
    AND (u.selected_share_id IS NULL AND u.selected_share_version IS NULL)
    AND (o.principal_kind='link_share' AND o.principal_id=u.link_share_id AND o.credential_version=u.link_share_version)
    AND EXISTS(SELECT 1 FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
      JOIN shares sh ON sh.id=ss.share_id
      WHERE (c.id=u.credential_id AND c.kind='share' AND ss.share_id=u.link_share_id)
        AND (ss.share_version=u.link_share_version AND ss.epoch=u.epoch)
        AND (sh.kind=CASE u.upload_only WHEN 1 THEN 'upload_only' ELSE 'link' END
          AND sh.owner_id=u.owner_id AND sh.version>=u.link_share_version)
        AND (u.upload_only=0 OR (u.target_id IS NULL AND EXISTS(SELECT 1 FROM reservations r
          WHERE r.id=u.reservation_id AND r.share_id=u.link_share_id AND r.owner_id=u.owner_id))))))`;
