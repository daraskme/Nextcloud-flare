import { type LinkShare, linkShareInput } from "./linkShares";

export interface UploadOnlyShareInput {
  kind: "upload_only";
  rootNodeId: string;
  reservationLimit: number;
  expiresAt: number | null;
  password?: string | null;
  rotateSecret?: boolean;
}
export interface UploadOnlyShare extends Omit<LinkShare, "kind" | "role" | "nodeKind"> {
  kind: "upload_only";
  nodeKind: "root" | "folder";
  reservationLimit: number;
  reservedBytes: number;
}

export function uploadOnlyShareInput(value: unknown, updating = false): UploadOnlyShareInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_request");
  const v = value as Record<string, unknown>;
  if (
    v.kind !== "upload_only" ||
    Object.keys(v).some(
      (key) =>
        ![
          "kind",
          "rootNodeId",
          "reservationLimit",
          "expiresAt",
          "password",
          "rotateSecret",
        ].includes(key),
    ) ||
    !Number.isSafeInteger(v.reservationLimit) ||
    (v.reservationLimit as number) < 0 ||
    (v.reservationLimit as number) > 7_505_999_378_950_825
  )
    throw new Error("invalid_share_request");
  const { reservationLimit, ...rest } = v;
  const {
    kind: _kind,
    role: _role,
    ...common
  } = linkShareInput({ ...rest, kind: "link", role: "read" }, updating);
  return { ...common, kind: "upload_only", reservationLimit: reservationLimit as number };
}
