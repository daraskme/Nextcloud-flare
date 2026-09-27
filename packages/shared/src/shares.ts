export type ShareRole = "read" | "edit";
export interface SelectedShare {
  readonly id: string;
  readonly version: number;
}
export function selectedShare(value: unknown): SelectedShare {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_selection");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "id,version" ||
    typeof v.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
    !Number.isSafeInteger(v.version) ||
    (v.version as number) < 1
  )
    throw new Error("invalid_share_selection");
  return Object.freeze({ id: v.id, version: v.version as number });
}
export interface InternalShareInput {
  kind: "internal";
  rootNodeId: string;
  recipients: string[];
  role: ShareRole;
  expiresAt: number | null;
}
export interface InternalShare {
  id: string;
  kind: "internal";
  rootNodeId: string;
  spaceId: string;
  ownerId: string;
  name: string;
  nodeKind: "root" | "folder" | "file";
  mountName: string | null;
  version: number;
  role: ShareRole;
  createdAt: number;
  expiresAt: number | null;
  recipients: { userId: string; email: string }[];
}
export function internalShareInput(value: unknown): InternalShareInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_request");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["kind", "rootNodeId", "recipients", "role", "expiresAt"].includes(k),
    ) ||
    v.kind !== "internal" ||
    typeof v.rootNodeId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.rootNodeId) ||
    !["read", "edit"].includes(v.role as string) ||
    !Array.isArray(v.recipients) ||
    v.recipients.length < 1 ||
    v.recipients.length > 20 ||
    v.recipients.some(
      (s) =>
        typeof s !== "string" || !/^[\x21-\x7e]{1,254}$/.test(s) || !/^[^@]+@[^@]+\.[^@]+$/.test(s),
    ) ||
    (v.expiresAt !== undefined &&
      v.expiresAt !== null &&
      (!Number.isSafeInteger(v.expiresAt) ||
        !Number.isFinite(new Date(v.expiresAt as number).getTime()) ||
        (v.expiresAt as number) <= Date.now()))
  )
    throw new Error("invalid_share_request");
  const recipients = (v.recipients as string[]).map((s) => s.toLowerCase()).sort();
  if (new Set(recipients).size !== recipients.length) throw new Error("invalid_share_request");
  return {
    kind: "internal",
    rootNodeId: v.rootNodeId,
    recipients,
    role: v.role as ShareRole,
    expiresAt: (v.expiresAt as number | null | undefined) ?? null,
  };
}
