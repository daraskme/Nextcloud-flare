import { mediaContentType } from "../../../shared/src/media";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { Env } from "../env";
import {
  IMAGE_METADATA_GENERATOR,
  type ImageMetadata,
  inspectImage,
} from "../media/images/inspect";
import { type ImageReadBudget, imageObjectSource } from "../media/images/r2Source";
import { sniffMediaContainer } from "../media/sniff";
import { TRACK_METADATA_GENERATOR, TRACK_METADATA_LIMITS } from "../media/tracks/common";
import { inspectTracks } from "../media/tracks/inspect";
import { hex } from "../platform/stream";
import { AUDIO_OVERRIDE_SNAPSHOT, audioSearchTags } from "../search/audio";
import { nodeSearchSteps } from "../search/projection";
import type { EventRow } from "./outboxAuthority";

export interface ImageNode {
  id: string;
  blob: string;
  parent: string;
  key: string;
  size: number;
  etag: string | null;
}
export interface PreparedImageMetadata {
  statements: readonly SqlStatement[];
  source?: {
    node: ImageNode & { etag: string };
    image: ImageMetadata;
    guard: () => Promise<void>;
    cover?: { bytes: Uint8Array; sha256: string };
  };
}
const SOURCE = `SELECT n.id,n.name,n.revision,n.current_blob_id AS blob,n.parent_id AS parent,b.r2_key AS key,b.size,s.r2_etag AS etag
  FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
  LEFT JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
  JOIN operation_steps step ON step.affected_id=b.id AND step.kind='blob'
  WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND step.op_id=? AND n.parent_id=?
    AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL
    AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id`;

/** Original file writes feed metadata through the same outbox claim and terminal transaction. */
export async function imageMetadataStatements(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "BLOBS">>,
  event: EventRow,
  claim: SqlStatement,
  authority: readonly SqlStatement[],
  deadline: number,
  budget: ImageReadBudget,
): Promise<PreparedImageMetadata> {
  if (
    !["upload.complete", "dav.put"].includes(event.op_kind) ||
    !["node.created", "node.updated"].includes(event.kind)
  )
    return { statements: [] };
  const values = [
    event.payload_ref,
    event.space_id,
    event.owner_id,
    event.op_id,
    JSON.parse(event.operands_json).parentId,
  ];
  const node = await primary(env.DB)
    .prepare(SOURCE)
    .bind(...values)
    .first<ImageNode & { name: string; revision: number }>();
  // An event superseded by another content write must never inspect or adopt that write's blob.
  if (!node) return { statements: [] };
  if (!env.BLOBS || !node.etag) throw new Error("image_source_unavailable");
  const hold = assertExists(
    SOURCE +
      " AND n.current_blob_id=? AND n.parent_id=? AND b.r2_key=? AND b.size=? AND s.r2_etag=? AND n.name=? AND n.revision=?",
    [...values, node.blob, node.parent, node.key, node.size, node.etag, node.name, node.revision],
  );
  const guard = async () => {
    await atomicBatch(env.DB, [...authority, claim, hold]);
  };
  await guard();
  const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const original = { key: node.key, size: node.size, etag: node.etag };
  const imageSource = imageObjectSource(env.BLOBS, original, signal, guard, budget);
  let trackCandidate = false;
  const image = await inspectImage({
    size: node.size,
    read: async (at, length) => {
      const bytes = await imageSource.read(at, length);
      if (at === 0) {
        const kind = sniffMediaContainer(bytes)?.container;
        trackCandidate = !!kind && kind !== "avif";
      }
      return bytes;
    },
  });
  const track =
    !image && trackCandidate
      ? await inspectTracks(
          imageObjectSource(env.BLOBS, original, signal, guard, budget, TRACK_METADATA_LIMITS),
        )
      : null;
  signal.throwIfAborted();
  const artwork = track?.media.kind === "audio" ? track.cover?.bytes : undefined;
  const coverImage = artwork
    ? await inspectImage({
        size: artwork.length,
        read: async (offset, length) => artwork.subarray(offset, offset + length),
      })
    : null;
  const cover =
    coverImage && artwork
      ? {
          bytes: artwork,
          sha256: hex(await crypto.subtle.digest("SHA-256", new Uint8Array(artwork))),
        }
      : undefined;
  // Even the no-image result belongs to this exact current blob and source authorization.
  const result: SqlStatement[] = [
    hold,
    { sql: "DELETE FROM node_media WHERE node_id=?", values: [node.id] },
    { sql: "DELETE FROM node_audio WHERE node_id=? AND blob_id<>?", values: [node.id, node.blob] },
  ];
  if (image)
    result.push(
      {
        sql: `INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,orientation,camera_make,camera_model)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        values: [
          node.id,
          node.blob,
          IMAGE_METADATA_GENERATOR,
          image.width,
          image.height,
          image.takenAt ?? null,
          image.orientation ?? 1,
          image.cameraMake ?? null,
          image.cameraModel ?? null,
        ],
      },
      {
        sql: "UPDATE blobs SET mime_sniffed=? WHERE id=? AND owner_id=?",
        values: [image.mime, node.blob, event.owner_id],
      },
    );
  if (track) {
    result.push(
      {
        sql: "INSERT INTO node_media(node_id,blob_id,generator_version,width,height,duration_ms) VALUES(?,?,?,?,?,?)",
        values: [
          node.id,
          node.blob,
          TRACK_METADATA_GENERATOR,
          track.width,
          track.height,
          track.durationMs,
        ],
      },
      {
        sql: "UPDATE blobs SET mime_sniffed=? WHERE id=? AND owner_id=?",
        values: [mediaContentType(track.media), node.blob, event.owner_id],
      },
    );
    if (track.media.kind === "audio") {
      const snapshot = await primary(env.DB)
        .prepare(AUDIO_OVERRIDE_SNAPSHOT)
        .bind(node.id)
        .first<string>("snapshot");
      const previous =
        snapshot === null
          ? null
          : (JSON.parse(snapshot) as [string, string | null, string | null, string | null]);
      const overrides = previous?.[0] === node.blob ? previous : null;
      const search = audioSearchTags({
        title: overrides?.[1] ?? track.title ?? null,
        artist: overrides?.[2] ?? track.artist ?? null,
        album: overrides?.[3] ?? track.album ?? null,
      });
      // This must precede the stale-blob DELETE above; a concurrent edit retries the whole event.
      result.unshift(
        assertExists(`SELECT 1 WHERE (${AUDIO_OVERRIDE_SNAPSHOT}) IS ?`, [node.id, snapshot]),
      );
      result.push({
        sql: `INSERT INTO node_audio(node_id,blob_id,generator_version,duration_ms,codec,title_extracted,artist_extracted,album_extracted,track_number,disc_number,search_text_norm,search_tokens,search_source,search_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET generator_version=excluded.generator_version,duration_ms=excluded.duration_ms,codec=excluded.codec,
        title_extracted=excluded.title_extracted,artist_extracted=excluded.artist_extracted,album_extracted=excluded.album_extracted,track_number=excluded.track_number,disc_number=excluded.disc_number,
        search_text_norm=excluded.search_text_norm,search_tokens=excluded.search_tokens,search_source=excluded.search_source,search_version=excluded.search_version
        WHERE node_audio.blob_id=excluded.blob_id`,
        values: [
          node.id,
          node.blob,
          TRACK_METADATA_GENERATOR,
          track.durationMs,
          track.media.codec,
          track.title ?? null,
          track.artist ?? null,
          track.album ?? null,
          track.trackNumber ?? null,
          track.discNumber ?? null,
          search.textNorm,
          search.tokens,
          search.source,
          search.version,
        ],
      });
      result.push(
        ...nodeSearchSteps(node.id, event.space_id, node.name, node.revision).flatMap((step) => [
          step.statement,
          assertOneChange,
        ]),
        {
          sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND owner_id=?",
          values: [event.space_id, event.owner_id],
        },
        assertOneChange,
      );
    }
  }
  return {
    statements: result,
    ...(image || (coverImage && cover)
      ? {
          source: {
            node: { ...node, etag: node.etag },
            image: (image ?? coverImage)!,
            guard,
            ...(cover ? { cover } : {}),
          },
        }
      : {}),
  };
}
