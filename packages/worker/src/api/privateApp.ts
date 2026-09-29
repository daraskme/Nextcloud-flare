import { problem } from "@next-cloud-flare/shared/errors";
import { AccessAuthenticationError, type AccessVerifier } from "../auth/access";
import type { AppPasswordPepperRing } from "../auth/appPassword";
import type { BootstrapPolicy } from "../auth/bootstrap";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import type { ListCursorTokens } from "../auth/listCursor";
import { loginAccessUser } from "../auth/login";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { SearchCursorTokens } from "../auth/searchCursor";
import type { SharePasswordRing } from "../auth/shareSecrets";
import type { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { handleAccountHttp } from "./account";
import { appPasswordRoute, handleAppPasswordHttp } from "./appPasswords";
import { audioReadRoute, handleAudioListHttp, handlePlaybackHttp, playbackRoute } from "./audio";
import { audioMetadataRoute, handleAudioMetadataHttp } from "./audioMetadata";
import { handlePrivateContentTicketHttp } from "./contentTickets";
import { copyJobRoute, handleCopyJobHttp } from "./copyJobs";
import { deadLetterReadRoute, deadLetterRoute, handleDeadLetterHttp } from "./deadLetters";
import { galleryRoute, handleGalleryHttp } from "./gallery";
import { handleLargeThumbnailHttp } from "./largeThumbnail";
import { handleLibraryBookHttp, libraryReadRoute } from "./library";
import { handleMediaExtractionHttp, mediaExtractionRoute } from "./mediaExtraction";
import { handleNodeMutationHttp, nodeMutationRoute } from "./nodeMutations";
import { handleNodeReadHttp, nodeReadRoute } from "./nodes";
import { handleSearchHttp, searchRoute } from "./search";
import { handleShareHttp, shareRoute } from "./shares";
import { handleStatsHttp, statsRoute } from "./stats";
import { handleThumbnailHttp, thumbnailRoute } from "./thumbnails";
import { handleTrashHttp, trashRoute } from "./trash";
import { handleUploadHttp, uploadReadRoute, uploadRoute } from "./uploads";
import { handleZipHttp, zipRoute } from "./zips";

export interface PrivateAppDependencies {
  readonly verifier: AccessVerifier;
  readonly csrf: CsrfTokens;
  readonly tokens: ContentTokens;
  readonly bootstrap: BootstrapPolicy;
  readonly cursors?: NodeCursorTokens;
  readonly searchCursors?: SearchCursorTokens;
  readonly listCursors?: ListCursorTokens;
  readonly appPasswordPepper?: AppPasswordPepperRing;
  readonly sharePasswords?: SharePasswordRing;
  readonly uploadCapabilities?: UploadCapabilities;
}

export function privateAppRoute(request: Request): boolean {
  const url = new URL(request.url);
  return (
    (request.method === "GET" && url.pathname === "/api/v1/me") ||
    nodeReadRoute(request) ||
    thumbnailRoute(request) ||
    mediaExtractionRoute(request) ||
    galleryRoute(request) ||
    audioReadRoute(request) ||
    libraryReadRoute(request) ||
    playbackRoute(request) ||
    audioMetadataRoute(request) ||
    searchRoute(request) ||
    statsRoute(request) ||
    trashRoute(request) ||
    nodeMutationRoute(request) ||
    copyJobRoute(request) ||
    deadLetterRoute(request) ||
    appPasswordRoute(request) ||
    shareRoute(request) ||
    uploadRoute(request) ||
    zipRoute(request) ||
    (request.method === "POST" &&
      (url.pathname === "/api/v1/csrf" ||
        url.pathname === "/api/v1/content-session" ||
        url.pathname === "/api/v1/auth/logout")) ||
    (request.method === "DELETE" && /^\/api\/v1\/tickets\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname))
  );
}

/** Access/CSRF verification and session registration precede all private ticket routes. */
export async function handlePrivateAppHttp(
  request: Request,
  env: Env,
  epoch: number,
  dependencies: PrivateAppDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    (url.search &&
      !nodeReadRoute(request) &&
      !thumbnailRoute(request) &&
      !galleryRoute(request) &&
      !audioReadRoute(request) &&
      !libraryReadRoute(request) &&
      !trashRoute(request) &&
      !deadLetterReadRoute(request) &&
      !uploadReadRoute(request) &&
      !searchRoute(request) &&
      !statsRoute(request) &&
      !shareRoute(request)) ||
    url.hash
  )
    return problem(404, "not_found");
  const csrfIssue = url.pathname === "/api/v1/csrf" && request.method === "POST";
  const accountRead = url.pathname === "/api/v1/me" && request.method === "GET";
  const logout = url.pathname === "/api/v1/auth/logout" && request.method === "POST";
  const nodeRead = nodeReadRoute(request);
  const thumbnail = thumbnailRoute(request);
  const mediaExtraction = mediaExtractionRoute(request);
  const gallery = galleryRoute(request);
  const audio = audioReadRoute(request);
  const library = libraryReadRoute(request);
  const playback = playbackRoute(request);
  const audioMetadata = audioMetadataRoute(request);
  const search = searchRoute(request);
  const stats = statsRoute(request);
  const trashRead = trashRoute(request);
  const nodeMutation = nodeMutationRoute(request);
  const copyJob = copyJobRoute(request);
  const deadLetters = deadLetterRoute(request);
  const appPassword = appPasswordRoute(request);
  const share = shareRoute(request);
  const upload = uploadRoute(request);
  const zip = zipRoute(request);
  const ticketIssue = url.pathname === "/api/v1/content-session" && request.method === "POST";
  const ticketCancel =
    /^\/api\/v1\/tickets\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && request.method === "DELETE";
  if (
    !csrfIssue &&
    !accountRead &&
    !logout &&
    !nodeRead &&
    !thumbnail &&
    !mediaExtraction &&
    !gallery &&
    !audio &&
    !library &&
    !playback &&
    !audioMetadata &&
    !search &&
    !stats &&
    !trashRead &&
    !nodeMutation &&
    !copyJob &&
    !deadLetters &&
    !appPassword &&
    !share &&
    !upload &&
    !zip &&
    !ticketIssue &&
    !ticketCancel
  )
    return problem(404, "not_found");
  let session;
  try {
    session = await loginAccessUser(
      env,
      dependencies.verifier,
      request,
      epoch,
      dependencies.bootstrap,
    );
  } catch (error) {
    if (error instanceof MutationUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    return error instanceof AccessAuthenticationError
      ? problem(401, "unauthorized")
      : problem(403, "forbidden");
  }
  if (csrfIssue) {
    try {
      const issued = await dependencies.csrf.issue(env.DB, request, {
        kind: "access",
        credentialId: session.credential_id,
        epoch: session.epoch,
      });
      return Response.json(issued, {
        status: 201,
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  if (accountRead || logout) return handleAccountHttp(request, env, session, dependencies.csrf);
  if (zip)
    return handleZipHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.csrf,
      dependencies.tokens,
      session.expires_at,
    );
  if (deadLetters)
    return handleDeadLetterHttp(request, env, session, dependencies.csrf, dependencies.listCursors);
  if (copyJob)
    return handleCopyJobHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.csrf,
    );
  if (share)
    return handleShareHttp(
      request,
      env,
      session,
      dependencies.csrf,
      dependencies.listCursors,
      dependencies.sharePasswords,
    );
  if (stats)
    return handleStatsHttp(request, env, {
      kind: "user",
      user_id: session.user_id,
      credential_id: session.credential_id,
      epoch: session.epoch,
    });
  if (upload)
    return handleUploadHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.csrf,
      dependencies.uploadCapabilities,
    );
  if (appPassword)
    return handleAppPasswordHttp(
      request,
      env,
      session,
      dependencies.csrf,
      dependencies.appPasswordPepper,
    );
  if (search)
    return handleSearchHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.searchCursors,
    );
  if (nodeRead)
    return handleNodeReadHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.cursors,
    );
  if (trashRead)
    return handleTrashHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.listCursors,
    );
  if (gallery)
    return handleGalleryHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.cursors,
    );
  if (library)
    return handleLibraryBookHttp(request, env, {
      kind: "user",
      user_id: session.user_id,
      credential_id: session.credential_id,
      epoch: session.epoch,
    });
  if (audio || playback || audioMetadata) {
    const principal = {
      kind: "user" as const,
      user_id: session.user_id,
      credential_id: session.credential_id,
      epoch: session.epoch,
    };
    return audio
      ? handleAudioListHttp(request, env, principal, dependencies.cursors)
      : audioMetadata
        ? handleAudioMetadataHttp(request, env, principal, dependencies.csrf)
        : handlePlaybackHttp(request, env, principal, dependencies.csrf);
  }
  if (thumbnail || mediaExtraction)
    if (request.method === "POST")
      return (mediaExtraction ? handleMediaExtractionHttp : handleLargeThumbnailHttp)(
        request,
        env,
        {
          kind: "user",
          user_id: session.user_id,
          credential_id: session.credential_id,
          epoch: session.epoch,
        },
        url.pathname.split("/")[4]!,
        dependencies.csrf,
      );
  if (thumbnail)
    return handleThumbnailHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      url.pathname.split("/")[4]!,
    );
  if (nodeMutation)
    return handleNodeMutationHttp(
      request,
      env,
      {
        kind: "user",
        user_id: session.user_id,
        credential_id: session.credential_id,
        epoch: session.epoch,
      },
      dependencies.csrf,
    );
  return handlePrivateContentTicketHttp(
    request,
    env,
    {
      kind: "user",
      user_id: session.user_id,
      credential_id: session.credential_id,
      epoch: session.epoch,
    },
    dependencies.csrf,
    dependencies.tokens,
    session.expires_at,
  );
}
