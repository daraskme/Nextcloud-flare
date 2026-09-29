import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertExists, atomicBatch, type SqlStatement } from "../db/primary";
import { IMAGE_TRANSFORM_GENERATOR, type ImageVariant } from "../media/images/transform";
import type { BlobReadPlan } from "./blobRead";
import { type ThumbnailTarget, thumbnailVariant } from "./thumbnailManifest";

const SOURCE = `FROM nodes n JOIN blobs original ON original.id=n.current_blob_id AND original.owner_id=n.owner_id
  JOIN image_transform_attempts t ON t.blob_id=original.id AND t.owner_id=n.owner_id
  JOIN image_derivative_objects x ON x.id=t.id AND x.source_blob_id=original.id AND x.owner_id=n.owner_id
  JOIN derivative_results d ON d.id=x.result_id AND d.blob_id=original.id
  JOIN blobs b ON b.id=x.output_blob_id AND b.owner_id=n.owner_id
  JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins p ON p.pin_id=x.pin_id AND p.blob_id=b.id
  JOIN image_derivative_cleanup c ON c.image_id=x.id
  WHERE (n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?)
    AND (n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL AND original.state IN ('committed','gc_candidate'))
    AND (t.variant=? AND t.generator_version=? AND t.state='succeeded')
    AND (d.kind='thumbnail' AND d.variant=t.variant AND d.generator_version=t.generator_version)
    AND (d.state='ready' AND x.state='published' AND b.state='committed' AND b.ref_count=1)
    AND (b.id='image_'||t.id AND d.id=b.id AND d.size=b.size AND d.r2_key=b.r2_key)
    AND b.r2_key='u/'||n.owner_id||'/d/'||original.id||'/'||t.generator_version||'/'||t.variant||'/'||t.id
    AND (b.mime_sniffed='image/webp' AND s.bytes=b.size AND s.removed_at IS NULL AND s.r2_etag=b.r2_etag)
    AND (b.sha256_verified=json_extract(t.output_json,'$.sha256') AND b.size=json_extract(t.output_json,'$.bytes'))
    AND (p.purpose='job' AND p.expires_at IS NULL AND c.retired_at IS NULL AND c.seal_token IS NULL
    AND c.settled_at IS NULL)
    AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='image.put' AND w.state='succeeded'
      AND w.epoch=t.epoch AND w.owner_id=t.owner_id AND w.r2_key=b.r2_key AND w.source_ref=json_array(x.id,x.write_attempt_id))
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')`;
const FENCE = `SELECT 1 ${SOURCE} AND (t.id=? AND b.size=? AND s.r2_etag=? AND b.content_etag=?)`;

/** Keep the 1,000-target publication within D1's statement, binding and expression-depth limits. */
export function thumbnailBatchAssertions(guards: readonly SqlStatement[]): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  let index = 0;
  const query = FENCE.replace(/\?/g, () => `json_extract(j.value,'$[${index++}]')`).replace(
    "SELECT 1 FROM nodes",
    "SELECT COUNT(*) FROM json_each(?) j CROSS JOIN nodes",
  );
  for (let at = 0; at < guards.length; at += 32) {
    const page = guards.slice(at, at + 32);
    if (page.some((g) => g.sql !== assertExists(FENCE).sql || g.values?.length !== 10))
      throw new Error("invalid_thumbnail_guard");
    statements.push(
      assertExists(`${query} HAVING COUNT(*)=?`, [
        JSON.stringify(page.map((g) => g.values)),
        page.length,
      ]),
    );
  }
  return statements;
}

/** Authority is for the current original node; only a published immutable output becomes a byte plan. */
export async function prepareAuthorizedThumbnailRead(
  db: D1Database,
  authorized: AuthorizedNode,
  variant: ImageVariant,
  extra: readonly SqlStatement[] = [],
  expected?: ThumbnailTarget,
) {
  if (authorized.operation !== "node.read") throw new Error("content_not_available");
  const n = authorized.node;
  if (n.kind !== "file" || !n.current_blob_id || !thumbnailVariant(variant))
    throw new Error("content_not_available");
  if (
    expected &&
    (expected.spaceId !== n.space_id ||
      expected.nodeId !== n.id ||
      expected.blobId !== n.current_blob_id ||
      expected.variant !== variant ||
      expected.generator !== IMAGE_TRANSFORM_GENERATOR ||
      expected.purpose !== "thumb")
  )
    throw new Error("content_not_available");
  const values = [
    n.id,
    n.space_id,
    n.revision,
    n.current_blob_id,
    variant,
    IMAGE_TRANSFORM_GENERATOR,
  ];
  const suffix = expected ? " AND t.id=? AND b.size=?" : "";
  const bindings = [...values, ...(expected ? [expected.imageId, expected.size] : [])];
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT b.r2_key AS key,b.size,s.r2_etag AS r2Etag,b.content_etag AS contentEtag,
      'image/webp' AS mime,'thumbnail.webp' AS name,t.id AS imageId ${SOURCE}${suffix}`,
      values: bindings,
    },
  ]);
  const row = batches[extra.length + 1]?.results[0] as
    | (BlobReadPlan & { imageId: string })
    | undefined;
  if (!row) throw new Error(expected ? "content_not_available" : "thumbnail_not_ready");
  const { imageId, ...blob } = row;
  const target: ThumbnailTarget = {
    spaceId: n.space_id,
    nodeId: n.id,
    blobId: n.current_blob_id,
    purpose: "thumb",
    variant,
    generator: IMAGE_TRANSFORM_GENERATOR,
    imageId,
    size: blob.size,
  };
  const guard = assertExists(FENCE, [...values, imageId, blob.size, blob.r2Etag, blob.contentEtag]);
  return { blob: Object.freeze(blob), target: Object.freeze(target), guard };
}
