export const RESTORE_DOMAIN_KINDS = [
  "single",
  "multipart",
  "images",
  "archives",
  "reservations",
  "outbox",
  "blob-gc",
  "orphan-gc",
  "orphan-inventory",
] as const;
export type RestoreDomainKind = (typeof RESTORE_DOMAIN_KINDS)[number];

export function restoreDomainKind(value: unknown): RestoreDomainKind {
  if (!RESTORE_DOMAIN_KINDS.includes(value as RestoreDomainKind))
    throw new Error("database_restore_invalid_repair_kind");
  return value as RestoreDomainKind;
}
