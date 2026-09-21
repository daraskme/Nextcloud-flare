import type { AudioAlbum, AudioTrackSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { getOwnedNode, getOwnerWorkspace } from "./nodes.js";

export const audioMetadataGenerator = "audio-v1";

interface TrackRow {
  nodeId: string;
  blobId: string;
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
  codec: string;
  bitrate: number | null;
  coverKey: string | null;
  overrideJson: string;
  positionMs: number | null;
}

function override(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function track(row: TrackRow): AudioTrackSummary {
  const custom = override(row.overrideJson);
  return {
    nodeId: row.nodeId,
    blobId: row.blobId,
    name: row.name,
    title: typeof custom.title === "string" ? custom.title : (row.title ?? row.name),
    artist: typeof custom.artist === "string" ? custom.artist : row.artist,
    album: typeof custom.album === "string" ? custom.album : row.album,
    trackNo: typeof custom.trackNo === "number" ? custom.trackNo : row.trackNo,
    discNo: typeof custom.discNo === "number" ? custom.discNo : row.discNo,
    durationMs: row.durationMs,
    codec: row.codec,
    bitrate: row.bitrate,
    coverUrl:
      row.coverKey === null ? null : `/api/v1/nodes/${encodeURIComponent(row.nodeId)}/audio/cover`,
    contentUrl: `/api/v1/nodes/${encodeURIComponent(row.nodeId)}/content`,
    positionMs: row.positionMs ?? 0,
  };
}

export async function listTracks(env: Env, userId: string, folderId: string): Promise<AudioAlbum> {
  const folder = await getOwnedNode(env, userId, folderId);
  if (folder.kind !== "root" && folder.kind !== "folder") throw new Error("not_a_folder");
  const workspace = await getOwnerWorkspace(env, userId);
  if (!(await isEffectiveLive(env, folder.id, workspace.rootId))) throw new Error("node_not_found");
  const count = await env.DB.prepare(
    "SELECT COUNT(*) value FROM nodes n JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id AND a.generator_version=?1 WHERE n.parent_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL",
  )
    .bind(audioMetadataGenerator, folder.id, userId)
    .first<{ value: number }>();
  if ((count?.value ?? 0) > 2000) throw new Error("audio_track_limit");
  const rows = await env.DB.prepare(
    "SELECT n.id nodeId,n.current_blob_id blobId,n.name,a.title,a.artist,a.album,a.track_no trackNo,a.disc_no discNo,a.duration_ms durationMs,a.codec,a.bitrate,a.cover_key coverKey,a.override_json overrideJson,p.position_ms positionMs FROM nodes n JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id AND a.generator_version=?1 LEFT JOIN user_playback_state p ON p.user_id=?2 AND p.node_id=n.id AND p.blob_id=n.current_blob_id WHERE n.parent_id=?3 AND n.owner_id=?2 AND n.deleted_at IS NULL ORDER BY COALESCE(a.disc_no,0),COALESCE(a.track_no,2147483647),n.name_ci,n.id LIMIT 2001",
  )
    .bind(audioMetadataGenerator, userId, folder.id)
    .all<TrackRow>();
  return { nodeId: folder.id, name: folder.name, tracks: rows.results.map(track) };
}

export async function savePlaybackState(
  env: Env,
  userId: string,
  nodeId: string,
  positionMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(positionMs) || positionMs < 0) {
    throw new RangeError("Playback position is invalid");
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user_playback_state(user_id,node_id,blob_id,position_ms,updated_at) SELECT ?1,n.id,n.current_blob_id,?2,?3 FROM nodes n JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id WHERE n.id=?4 AND n.owner_id=?1 AND n.kind='file' AND n.deleted_at IS NULL ON CONFLICT(user_id,node_id,blob_id) DO UPDATE SET position_ms=excluded.position_ms,updated_at=excluded.updated_at",
    ).bind(userId, positionMs, Date.now(), nodeId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

export async function updateAudioMetadata(
  env: Env,
  userId: string,
  nodeId: string,
  input: {
    title?: string;
    artist?: string;
    album?: string;
    trackNo?: number;
    discNo?: number;
  },
): Promise<void> {
  const normalized = {
    ...(input.title === undefined ? {} : { title: input.title.slice(0, 1024) }),
    ...(input.artist === undefined ? {} : { artist: input.artist.slice(0, 1024) }),
    ...(input.album === undefined ? {} : { album: input.album.slice(0, 1024) }),
    ...(input.trackNo === undefined ? {} : { trackNo: input.trackNo }),
    ...(input.discNo === undefined ? {} : { discNo: input.discNo }),
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_audio SET override_json=?1,updated_at=?2 WHERE node_id=?3 AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=node_audio.node_id AND n.owner_id=?4 AND n.current_blob_id=node_audio.blob_id AND n.deleted_at IS NULL)",
    ).bind(JSON.stringify(normalized), Date.now(), nodeId, userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

export async function serveAudioCover(
  env: Env,
  userId: string,
  nodeId: string,
  head: boolean,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT a.cover_key coverKey,n.id nodeId,n.owner_id ownerId,s.root_node_id rootId FROM node_audio a JOIN nodes n ON n.id=a.node_id JOIN spaces s ON s.id=n.space_id WHERE n.id=?1 AND n.owner_id=?2 AND n.current_blob_id=a.blob_id AND n.deleted_at IS NULL AND a.cover_key IS NOT NULL",
  )
    .bind(nodeId, userId)
    .first<{ coverKey: string; nodeId: string; ownerId: string; rootId: string }>();
  if (row === null || !(await isEffectiveLive(env, row.nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  const object = head ? await env.BLOBS.head(row.coverKey) : await env.BLOBS.get(row.coverKey);
  if (object === null) throw new Error("derivative_inconsistent");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(head ? null : (object as R2ObjectBody).body, { headers });
}
