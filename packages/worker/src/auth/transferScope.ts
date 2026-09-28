import { type SelectedShare, selectedShare } from "../../../shared/src/shares";
import type { Principal } from "./authorize";

/** Omission preserves legacy single-scope transfers; null share explicitly means the actor's space. */
export interface TransferDestination {
  readonly spaceId: string;
  readonly share: SelectedShare | null;
}
export interface TransferDestinationRecord {
  readonly destination_space_id: string | null;
  readonly destination_share_id: string | null;
  readonly destination_share_version: number | null;
}
export function transferDestination(
  value: TransferDestination | undefined,
): TransferDestination | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "share,spaceId" ||
    typeof value.spaceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.spaceId)
  )
    throw new Error("invalid_transfer_scope");
  return Object.freeze({
    spaceId: value.spaceId,
    share: value.share === null ? null : selectedShare(value.share),
  });
}
export function storedDestination(row: TransferDestinationRecord): TransferDestination | undefined {
  if (
    row.destination_space_id === null &&
    row.destination_share_id === null &&
    row.destination_share_version === null
  )
    return undefined;
  if (row.destination_space_id === null) throw new Error("invalid_transfer_scope");
  return transferDestination({
    spaceId: row.destination_space_id,
    share:
      row.destination_share_id === null && row.destination_share_version === null
        ? null
        : selectedShare({ id: row.destination_share_id, version: row.destination_share_version }),
  });
}
export function sameDestination(
  row: TransferDestinationRecord,
  destination: TransferDestination | undefined,
): boolean {
  return (
    row.destination_space_id === (destination?.spaceId ?? null) &&
    row.destination_share_id === (destination?.share?.id ?? null) &&
    row.destination_share_version === (destination?.share?.version ?? null)
  );
}
export function destinationPrincipal(
  principal: Principal,
  destination: TransferDestination | undefined,
): Principal {
  if (!destination) return principal;
  if (principal.kind !== "user" && principal.kind !== "app_password")
    throw new Error("invalid_transfer_scope");
  return Object.freeze({
    kind: principal.kind,
    user_id: principal.user_id,
    credential_id: principal.credential_id,
    epoch: principal.epoch,
    ...(destination.share ? { selected_share: destination.share } : {}),
  });
}
