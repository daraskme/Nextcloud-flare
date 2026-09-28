import { type SelectedShare, selectedShare } from "../../../shared/src/shares";
import type { Principal } from "./authorize";

export interface SelectedShareRecord {
  readonly selected_share_id: string | null;
  readonly selected_share_version: number | null;
}

export function principalSelection(principal: Principal): SelectedShare | undefined {
  if (!("selected_share" in principal)) return undefined;
  if (principal.kind !== "user" && principal.kind !== "app_password")
    throw new Error("invalid_share_selection");
  return selectedShare(principal.selected_share);
}

export function storedSelection(row: SelectedShareRecord): SelectedShare | undefined {
  if (row.selected_share_id === null && row.selected_share_version === null) return undefined;
  return selectedShare({ id: row.selected_share_id, version: row.selected_share_version });
}

export function freezePrincipal(principal: Principal): Principal {
  const share = principalSelection(principal);
  return Object.freeze({ ...principal, ...(share ? { selected_share: share } : {}) });
}

/** A durable record supplies scope; a caller can never replace it with another grant. */
export function storedPrincipal(principal: Principal, row: SelectedShareRecord): Principal {
  const requested = principalSelection(principal);
  const saved = storedSelection(row);
  if (
    (saved && principal.kind !== "user" && principal.kind !== "app_password") ||
    (requested && (requested.id !== saved?.id || requested.version !== saved?.version))
  )
    throw new Error("share_selection_mismatch");
  return Object.freeze({ ...principal, ...(saved ? { selected_share: saved } : {}) });
}
