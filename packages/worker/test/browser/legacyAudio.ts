import { mediaContentType } from "../../../shared/src/media";
import { assertExists, atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { imageObjectSource } from "../../src/media/images/r2Source";
import { TRACK_METADATA_LIMITS } from "../../src/media/tracks/common";
import { inspectTracks } from "../../src/media/tracks/inspect";

/** Test-only old-deployment fixture: finish metadata extraction without a cover generation. */
export async function legacyAudioFixture(env: Env, nodeId: string) {
  const node =
    await env.DB.prepare(`SELECT n.current_blob_id AS blob,n.last_op_id AS op,b.r2_key AS key,b.size,s.r2_etag AS etag
    FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN blob_storage s ON s.blob_id=b.id
    JOIN operations o ON o.op_id=n.last_op_id AND o.kind='upload.complete' AND o.state='committed'
    WHERE n.id=? AND n.kind='file' AND b.size<=65536 AND b.size=s.bytes AND s.removed_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM node_audio WHERE node_id=n.id)
    AND NOT EXISTS(SELECT 1 FROM image_transform_attempts WHERE blob_id=b.id)`)
      .bind(nodeId)
      .first<{ blob: string; op: string; key: string; size: number; etag: string }>();
  if (!node) throw new Error("invalid_legacy_audio_fixture");
  const track = await inspectTracks(
    imageObjectSource(
      env.BLOBS,
      node,
      AbortSignal.timeout(5000),
      async () => {},
      { bytes: 0, reads: 0 },
      TRACK_METADATA_LIMITS,
    ),
  );
  if (!track || track.media.kind !== "audio") throw new Error("invalid_legacy_audio_fixture");
  await atomicBatch(env.DB, [
    assertExists("SELECT 1 FROM nodes WHERE id=? AND current_blob_id=? AND last_op_id=?", [
      nodeId,
      node.blob,
      node.op,
    ]),
    {
      sql: "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms,title_extracted,artist_extracted,album_extracted) VALUES(?,?,'track-metadata-v1',?,?,?,?,?)",
      values: [
        nodeId,
        node.blob,
        track.media.codec,
        track.durationMs,
        track.title ?? null,
        track.artist ?? null,
        track.album ?? null,
      ],
    },
    {
      sql: "UPDATE blobs SET mime_sniffed=? WHERE id=?",
      values: [mediaContentType(track.media), node.blob],
    },
    {
      sql: "UPDATE outbox SET state='completed' WHERE op_id=? AND kind='node.created'",
      values: [node.op],
    },
  ]);
  return { nodeId, blobId: node.blob };
}
