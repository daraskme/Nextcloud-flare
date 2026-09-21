export function parseDavTimeout(value: string | null): number {
  if (value === null || value.trim() === "") {
    return 600;
  }
  if (value.trim().toLowerCase() === "infinite") {
    return 3600;
  }
  const match = /^Second-(\d+)$/iu.exec(value.trim());
  if (match?.[1] === undefined) {
    throw new RangeError("DAV Timeout is invalid");
  }
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError("DAV Timeout is invalid");
  }
  return Math.min(seconds, 3600);
}

export function davEtag(nodeId: string, revision: number, blobId?: string): string {
  if (blobId !== undefined) {
    return `"b-${blobId}"`;
  }
  return `"c-${nodeId}-${revision}"`;
}

export function requiresDavPutPrecondition(
  existing: boolean,
  ifMatch: string | null,
  lock: boolean,
): boolean {
  return existing && ifMatch === null && !lock;
}
