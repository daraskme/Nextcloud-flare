const MIB = 1024 * 1024;
export const UPLOAD_LIMITS = {
  bytes: 500 * 1024 * MIB,
  parts: 10_000,
  defaultPartBytes: 64 * MIB,
  minPartBytes: 8 * MIB,
  maxPartBytes: 90 * MIB,
  parallel: 4,
  attempts: 3,
  leaseMs: 15 * 60_000,
  lifetimeMs: 6 * 24 * 60 * 60_000,
  idleMs: 24 * 60 * 60_000,
} as const;

export interface MultipartPlan {
  readonly declaredBytes: number;
  readonly partBytes: number;
  readonly partCount: number;
}

/** Server-selected geometry, fixed before any part is accepted. Zero bytes use single PUT. */
export function multipartPlan(
  declaredBytes: number,
  partBytes: number = UPLOAD_LIMITS.defaultPartBytes,
): MultipartPlan {
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 1 ||
    declaredBytes > UPLOAD_LIMITS.bytes ||
    !Number.isSafeInteger(partBytes) ||
    partBytes < UPLOAD_LIMITS.minPartBytes ||
    partBytes > UPLOAD_LIMITS.maxPartBytes
  )
    throw new Error("invalid_multipart_plan");
  const partCount = Math.ceil(declaredBytes / partBytes);
  if (partCount > UPLOAD_LIMITS.parts) throw new Error("multipart_part_limit");
  return Object.freeze({ declaredBytes, partBytes, partCount });
}

export function expectedPartBytes(plan: MultipartPlan, partNumber: number): number {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount)
    throw new Error("invalid_part_number");
  return Math.min(plan.partBytes, plan.declaredBytes - (partNumber - 1) * plan.partBytes);
}
