export interface ZipReceipt {
  readonly id: string;
  readonly size: number;
  readonly expiresAt: number;
  readonly url: string;
}

export function zipFailureMessage(status: number): string | undefined {
  if (status === 413)
    return "ZIPにまとめられるのは1,000項目までです。下の階層のフォルダーを選んでください。";
  if (status === 409)
    return "フォルダーの内容が変わったか、ZIPにまとめられない項目があります。一覧を更新し、必要に応じて下の階層のフォルダーを選んでください。";
  if (status === 429)
    return "ダウンロードの利用上限に達しました。しばらく待ってから再試行してください。";
  return undefined;
}

/** A server receipt can only navigate to the matching same-app ZIP selector. */
export function zipDownloadPath(value: unknown, shareId?: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_zip_receipt");
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !== "expiresAt,id,size,url" ||
    typeof receipt.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id) ||
    !Number.isSafeInteger(receipt.size) ||
    (receipt.size as number) < 22 ||
    (receipt.size as number) > 4_294_967_295 ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    (receipt.expiresAt as number) <= 0 ||
    (shareId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(shareId))
  )
    throw new Error("invalid_zip_receipt");
  const path = `${shareId ? `/api/v1/public/shares/${shareId}` : "/api/v1"}/zips/${receipt.id}`;
  if (receipt.url !== path) throw new Error("invalid_zip_receipt");
  return path;
}
