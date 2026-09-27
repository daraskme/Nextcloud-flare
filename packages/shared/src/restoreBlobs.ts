/** Identity only; endpoints and credentials are always taken from trusted Worker settings. */
export interface RestoreBlobsTarget {
  accountId: string;
  bucket: string;
  jurisdiction: "default" | "eu" | "us" | "fedramp";
}

export function restoreBlobsTarget(input: unknown): RestoreBlobsTarget {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("database_restore_invalid_blobs_target");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["accountId", "bucket", "jurisdiction"].includes(key)) ||
    typeof value.accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.accountId) ||
    typeof value.bucket !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucket) ||
    !["default", "eu", "us", "fedramp"].includes(value.jurisdiction as string)
  )
    throw new Error("database_restore_invalid_blobs_target");
  return {
    accountId: value.accountId,
    bucket: value.bucket,
    jurisdiction: value.jurisdiction as RestoreBlobsTarget["jurisdiction"],
  };
}
