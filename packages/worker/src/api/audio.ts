import { authenticateAccessUser } from "../auth/httpAuth.js";
import { authenticateShare } from "../auth/share.js";
import {
  listTracks,
  savePlaybackState,
  serveAudioCover,
  updateAudioMetadata,
} from "../services/audio.js";
import { acquireBudget, attachBudgetLease } from "../services/budgets.js";
import { assertShareNode } from "../services/shares.js";
import { type AppContext, jsonError, mapError } from "./http.js";

export async function handleTracks(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    if (!user.principal.scopes.includes("library:read")) {
      return jsonError(context, 403, "forbidden", "Audio access is not allowed");
    }
    return context.json(
      await listTracks(context.env, user.principal.userId, context.req.param("nodeId")),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "audio_track_limit") {
      return jsonError(context, 413, "audio_track_limit", "An album is limited to 2,000 tracks");
    }
    return mapError(context, error);
  }
}

export async function handleUpdateAudio(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    if (!user.principal.scopes.includes("node:write")) {
      return jsonError(context, 403, "forbidden", "Audio metadata cannot be changed");
    }
    const body = await context.req.json<{
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      trackNo?: unknown;
      discNo?: unknown;
    }>();
    if (
      (body.title !== undefined && typeof body.title !== "string") ||
      (body.artist !== undefined && typeof body.artist !== "string") ||
      (body.album !== undefined && typeof body.album !== "string") ||
      (body.trackNo !== undefined &&
        (typeof body.trackNo !== "number" ||
          !Number.isSafeInteger(body.trackNo) ||
          body.trackNo < 0)) ||
      (body.discNo !== undefined &&
        (typeof body.discNo !== "number" || !Number.isSafeInteger(body.discNo) || body.discNo < 0))
    ) {
      throw new RangeError("Audio metadata is invalid");
    }
    await updateAudioMetadata(context.env, user.principal.userId, context.req.param("nodeId"), {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.artist === "string" ? { artist: body.artist } : {}),
      ...(typeof body.album === "string" ? { album: body.album } : {}),
      ...(typeof body.trackNo === "number" ? { trackNo: body.trackNo } : {}),
      ...(typeof body.discNo === "number" ? { discNo: body.discNo } : {}),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePlaybackState(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    if (!user.principal.scopes.includes("state:write")) {
      return jsonError(context, 403, "forbidden", "Playback state cannot be changed");
    }
    const body = await context.req.json<{ positionMs?: unknown }>();
    if (typeof body.positionMs !== "number") throw new RangeError("Playback position is invalid");
    await savePlaybackState(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
      body.positionMs,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleAudioCover(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    if (!user.principal.scopes.includes("library:read")) {
      return jsonError(context, 403, "forbidden", "Audio access is not allowed");
    }
    return await serveAudioCover(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
      context.req.method === "HEAD",
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicTracks(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const folderId = authentication.share.rootNodeId;
    await assertShareNode(context.env, authentication.share, folderId, "read");
    const album = await listTracks(context.env, authentication.share.ownerId, folderId);
    return context.json({
      ...album,
      tracks: album.tracks.map((track) => ({
        ...track,
        contentUrl: `/api/v1/public/shares/${encodeURIComponent(authentication.share.id)}/content/${encodeURIComponent(track.nodeId)}`,
        coverUrl:
          track.coverUrl === null
            ? null
            : `/api/v1/public/shares/${encodeURIComponent(authentication.share.id)}/audio/${encodeURIComponent(track.nodeId)}/cover`,
      })),
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePublicAudioCover(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const nodeId = context.req.param("nodeId");
    await assertShareNode(context.env, authentication.share, nodeId, "read");
    const response = await serveAudioCover(
      context.env,
      authentication.share.ownerId,
      nodeId,
      context.req.method === "HEAD",
    );
    const bytes =
      context.req.method === "HEAD" ? 0 : Number(response.headers.get("Content-Length") ?? 0);
    const lease = await acquireBudget(
      context.env,
      authentication.budgetId,
      authentication.budgetMaxBytes,
      bytes,
    );
    return await attachBudgetLease(response, lease);
  } catch (error) {
    return mapError(context, error);
  }
}
