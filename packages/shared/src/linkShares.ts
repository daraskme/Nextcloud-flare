import type { ShareRole } from "./shares";

export interface LinkShareInput {
  kind: "link";
  rootNodeId: string;
  role: ShareRole;
  expiresAt: number | null;
  /** Omitted on update preserves the password; null explicitly removes it. */
  password?: string | null;
  rotateSecret?: boolean;
}
export interface LinkShare {
  id: string;
  kind: "link";
  rootNodeId: string;
  spaceId: string;
  ownerId: string;
  name: string;
  nodeKind: "root" | "folder" | "file";
  version: number;
  role: ShareRole;
  createdAt: number;
  expiresAt: number | null;
  hasPassword: boolean;
}
export function validSharePassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const encoded = new TextEncoder().encode(value);
  return (
    encoded.length <= 1024 &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) === value
  );
}
export function linkShareInput(value: unknown, updating = false): LinkShareInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_request");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        !["kind", "rootNodeId", "role", "expiresAt", "password", "rotateSecret"].includes(key),
    ) ||
    v.kind !== "link" ||
    typeof v.rootNodeId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.rootNodeId) ||
    !["read", "edit"].includes(v.role as string) ||
    (v.expiresAt !== undefined &&
      v.expiresAt !== null &&
      (!Number.isSafeInteger(v.expiresAt) ||
        !Number.isFinite(new Date(v.expiresAt as number).getTime()) ||
        (v.expiresAt as number) <= Date.now())) ||
    (v.password !== undefined && v.password !== null && !validSharePassword(v.password)) ||
    (v.rotateSecret !== undefined && (!updating || typeof v.rotateSecret !== "boolean"))
  )
    throw new Error("invalid_share_request");
  return {
    kind: "link",
    rootNodeId: v.rootNodeId,
    role: v.role as ShareRole,
    expiresAt: (v.expiresAt as number | null | undefined) ?? null,
    ...(Object.hasOwn(v, "password") ? { password: v.password as string | null } : {}),
    ...(v.rotateSecret === undefined ? {} : { rotateSecret: v.rotateSecret as boolean }),
  };
}
