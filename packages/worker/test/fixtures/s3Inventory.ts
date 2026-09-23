import type { InventoryConfigEnv } from "../../src/r2/s3Inventory";
export const inventoryEnv: InventoryConfigEnv = {
  R2_INVENTORY_ACCOUNT_ID: "a".repeat(32),
  R2_INVENTORY_BUCKET: "test-blobs",
  R2_INVENTORY_ACCESS_KEY_ID: "b".repeat(32),
  R2_INVENTORY_SECRET_ACCESS_KEY: "c".repeat(64),
};
export const xml = (name: string, content: string) =>
  `<${name} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${content}</${name}>`;
export const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export const tag = (name: string, value: string | number | boolean) =>
  `<${name}>${escapeXml(String(value))}</${name}>`;
export function uploadXml(key = "u/owner/b/blob", uploadId = "upload-1") {
  return `<Upload>${tag("Key", encodeURIComponent(key))}${tag("UploadId", uploadId)}<Initiated>2026-09-20T01:02:03.000Z</Initiated></Upload>`;
}
export function uploadsXml(
  options: {
    uploads?: string;
    truncated?: boolean;
    keyMarker?: string;
    idMarker?: string;
    nextKey?: string;
    nextId?: string;
    limit?: number;
    prefix?: string;
  } = {},
) {
  return xml(
    "ListMultipartUploadsResult",
    `<Bucket>test-blobs</Bucket><EncodingType>url</EncodingType>${tag("Prefix", encodeURIComponent(options.prefix ?? "u/"))}${tag("KeyMarker", encodeURIComponent(options.keyMarker ?? ""))}${tag("UploadIdMarker", options.idMarker ?? "")}${tag("MaxUploads", options.limit ?? 20)}${tag("IsTruncated", options.truncated ?? false)}${tag("NextKeyMarker", encodeURIComponent(options.nextKey ?? ""))}${tag("NextUploadIdMarker", options.nextId ?? "")}${options.uploads ?? uploadXml()}`,
  );
}
export function partXml(partNumber = 1, bytes = 123) {
  return `<Part>${tag("PartNumber", partNumber)}<LastModified>2026-09-20T01:02:03.000Z</LastModified><ETag>&quot;abc&quot;</ETag>${tag("Size", bytes)}</Part>`;
}
export function partsXml(
  options: {
    key?: string;
    uploadId?: string;
    parts?: string;
    marker?: number;
    next?: number;
    limit?: number;
    truncated?: boolean;
  } = {},
) {
  return xml(
    "ListPartsResult",
    `<Bucket>test-blobs</Bucket>${tag("Key", options.key ?? "u/owner/b/blob")}${tag("UploadId", options.uploadId ?? "upload-1")}${tag("PartNumberMarker", options.marker ?? 0)}${tag("NextPartNumberMarker", options.next ?? 0)}${tag("MaxParts", options.limit ?? 20)}${tag("IsTruncated", options.truncated ?? false)}${options.parts ?? partXml()}`,
  );
}
export function lifecycleRule(
  options: { id?: string; days?: number; status?: string; filter?: string } = {},
) {
  return `<Rule>${tag("ID", options.id ?? "abort-seven-days")}${tag("Status", options.status ?? "Enabled")}${options.filter ?? "<Filter><Prefix>u/</Prefix></Filter>"}<AbortIncompleteMultipartUpload>${tag("DaysAfterInitiation", options.days ?? 7)}</AbortIncompleteMultipartUpload></Rule>`;
}
