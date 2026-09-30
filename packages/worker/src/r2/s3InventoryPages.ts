import {
  boolean,
  fields,
  integer,
  invalidS3Xml,
  optional,
  s3Xml,
  scalar,
  timestamp,
  urlDecoded,
  utf8,
} from "./s3Xml";

export interface MultipartMarker {
  key: string;
  uploadId: string;
}
export interface MultipartInventoryPage {
  uploads: { key: string; uploadId: string; initiatedAt: number }[];
  next: MultipartMarker | null;
}
export interface PartInventoryPage {
  parts: { partNumber: number; etag: string; bytes: number; modifiedAt: number }[];
  next: number | null;
}
export interface MultipartLifecycle {
  abortRules: { id: string; enabled: boolean; prefix: string | null; days: number }[];
  sevenDayCoverage: boolean;
}

function keyOrder(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function multipartPage(
  xml: string,
  expected: { bucket: string; prefix: string; limit: number; marker: MultipartMarker | null },
): MultipartInventoryPage {
  const root = s3Xml(xml, "ListMultipartUploadsResult");
  fields(
    root,
    [
      "Bucket",
      "Prefix",
      "Delimiter",
      "EncodingType",
      "KeyMarker",
      "UploadIdMarker",
      "NextKeyMarker",
      "NextUploadIdMarker",
      "MaxUploads",
      "IsTruncated",
    ],
    ["Upload"],
  );
  if (
    scalar(root, "Bucket") !== expected.bucket ||
    scalar(root, "EncodingType") !== "url" ||
    urlDecoded(scalar(root, "Prefix", "")) !== expected.prefix ||
    scalar(root, "Delimiter", "") !== "" ||
    urlDecoded(scalar(root, "KeyMarker", "")) !== (expected.marker?.key ?? "") ||
    scalar(root, "UploadIdMarker", "") !== (expected.marker?.uploadId ?? "") ||
    integer(scalar(root, "MaxUploads"), 1, 1000) !== expected.limit
  )
    invalidS3Xml();
  const truncated = boolean(scalar(root, "IsTruncated"));
  const uploads = root.children
    .filter((child) => child.name === "Upload")
    .map((node) => {
      fields(node, [
        "Key",
        "UploadId",
        "Initiated",
        "Initiator",
        "Owner",
        "StorageClass",
        "ChecksumAlgorithm",
        "ChecksumType",
      ]);
      const key = utf8(urlDecoded(scalar(node, "Key")), 1, 1024);
      const uploadId = utf8(scalar(node, "UploadId"), 1, 2048);
      if (!key.startsWith(expected.prefix)) invalidS3Xml();
      return { key, uploadId, initiatedAt: timestamp(scalar(node, "Initiated")) };
    });
  if (uploads.length > expected.limit) invalidS3Xml();
  const seen = new Set<string>();
  let previousKey = expected.marker?.key ?? "";
  let previousInitiatedAt = 0;
  for (const upload of uploads) {
    const pair = JSON.stringify([upload.key, upload.uploadId]);
    if (
      seen.has(pair) ||
      (upload.key === expected.marker?.key && upload.uploadId === expected.marker.uploadId)
    )
      invalidS3Xml();
    seen.add(pair);
    const order = keyOrder(upload.key, previousKey);
    if (order < 0 || (order === 0 && upload.initiatedAt < previousInitiatedAt)) invalidS3Xml();
    previousKey = upload.key;
    previousInitiatedAt = upload.initiatedAt;
  }
  const key = urlDecoded(scalar(root, "NextKeyMarker", ""));
  const uploadId = scalar(root, "NextUploadIdMarker", "");
  if (key) utf8(key, 1, 1024);
  if (uploadId) utf8(uploadId, 1, 2048);
  const last = uploads.at(-1);
  if (truncated && (!last || key !== last.key || uploadId !== last.uploadId)) invalidS3Xml();
  return { uploads, next: truncated ? { key, uploadId } : null };
}

export function partPage(
  xml: string,
  expected: { bucket: string; key: string; uploadId: string; limit: number; marker: number },
): PartInventoryPage {
  const root = s3Xml(xml, "ListPartsResult");
  fields(
    root,
    [
      "Bucket",
      "Key",
      "UploadId",
      "Initiator",
      "Owner",
      "StorageClass",
      "ChecksumAlgorithm",
      "ChecksumType",
      "PartNumberMarker",
      "NextPartNumberMarker",
      "MaxParts",
      "IsTruncated",
    ],
    ["Part"],
  );
  if (
    scalar(root, "Bucket") !== expected.bucket ||
    scalar(root, "Key") !== expected.key ||
    scalar(root, "UploadId") !== expected.uploadId ||
    integer(scalar(root, "PartNumberMarker"), 0, 10000) !== expected.marker ||
    integer(scalar(root, "MaxParts"), 1, 1000) !== expected.limit
  )
    invalidS3Xml();
  const truncated = boolean(scalar(root, "IsTruncated"));
  let previous = expected.marker;
  const parts = root.children
    .filter((child) => child.name === "Part")
    .map((node) => {
      fields(node, [
        "PartNumber",
        "LastModified",
        "ETag",
        "Size",
        "ChecksumCRC32",
        "ChecksumCRC32C",
        "ChecksumCRC64NVME",
        "ChecksumSHA1",
        "ChecksumSHA256",
        "ChecksumSHA512",
        "ChecksumMD5",
        "ChecksumXXHASH128",
        "ChecksumXXHASH3",
        "ChecksumXXHASH64",
      ]);
      const partNumber = integer(scalar(node, "PartNumber"), 1, 10000);
      if (partNumber <= previous) invalidS3Xml();
      previous = partNumber;
      return {
        partNumber,
        etag: utf8(scalar(node, "ETag"), 1, 256),
        bytes: integer(scalar(node, "Size"), 0, Number.MAX_SAFE_INTEGER),
        modifiedAt: timestamp(scalar(node, "LastModified")),
      };
    });
  if (parts.length > expected.limit) invalidS3Xml();
  const next = integer(scalar(root, "NextPartNumberMarker", "0"), 0, 10000);
  if (truncated && (!parts.length || next !== previous || next >= 10000)) invalidS3Xml();
  return { parts, next: truncated ? next : null };
}

/** Diagnostic only: matching lifecycle configuration is never evidence that a handle is closed. */
export function multipartLifecycle(xml: string, prefix: string): MultipartLifecycle {
  const root = s3Xml(xml, "LifecycleConfiguration");
  fields(root, [], ["Rule"]);
  if (root.children.length > 1000) invalidS3Xml();
  const abortRules: MultipartLifecycle["abortRules"] = [];
  const ids = new Set<string>();
  for (const rule of root.children) {
    fields(
      rule,
      [
        "ID",
        "Status",
        "Filter",
        "Prefix",
        "AbortIncompleteMultipartUpload",
        "Expiration",
        "NoncurrentVersionExpiration",
      ],
      ["Transition", "NoncurrentVersionTransition"],
    );
    const id = utf8(scalar(rule, "ID", ""), 0, 255);
    if (id && ids.has(id)) invalidS3Xml();
    if (id) ids.add(id);
    const status = scalar(rule, "Status");
    if (status !== "Enabled" && status !== "Disabled") invalidS3Xml();
    const abort = optional(rule, "AbortIncompleteMultipartUpload");
    if (!abort) continue;
    fields(abort, ["DaysAfterInitiation"]);
    const days = integer(scalar(abort, "DaysAfterInitiation"), 1, 2_147_483_647);
    const filter = optional(rule, "Filter");
    const legacy = optional(rule, "Prefix");
    if (filter && legacy) invalidS3Xml();
    let scope: string | null = null;
    if (legacy) scope = scalar(rule, "Prefix");
    else if (filter) {
      fields(filter, ["Prefix", "Tag", "And", "ObjectSizeGreaterThan", "ObjectSizeLessThan"]);
      // Tag/size/And selectors cannot prove coverage of every incomplete handle.
      if (
        !filter.children.length ||
        (filter.children.length === 1 && filter.children[0]!.name === "Prefix")
      )
        scope = scalar(filter, "Prefix", "");
    }
    if (scope !== null) utf8(scope, 0, 1024);
    abortRules.push({ id, enabled: status === "Enabled", prefix: scope, days });
  }
  const enabled = abortRules.filter((rule) => rule.enabled);
  const sevenDayCoverage =
    enabled.some(
      (rule) => rule.prefix !== null && prefix.startsWith(rule.prefix) && rule.days === 7,
    ) &&
    !enabled.some(
      (rule) =>
        rule.prefix === null ||
        (rule.days < 7 && (prefix.startsWith(rule.prefix) || rule.prefix.startsWith(prefix))),
    );
  return { abortRules, sevenDayCoverage };
}
