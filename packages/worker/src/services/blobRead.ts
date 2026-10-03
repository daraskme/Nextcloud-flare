import { mediaContentType } from "@next-cloud-flare/shared/media";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { type ContentPurpose, contentSessionAssertion } from "../auth/contentSession";
import type { ContentTokens } from "../auth/contentTokens";
import { shareCoverageAssertion } from "../auth/shareCoverage";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { BudgetDO } from "../do/BudgetDO";
import { AUDIO_GENERATOR_VERSION } from "../media/audio";
import { IMAGE_METADATA_GENERATOR } from "../media/images/metadata";
import { IMAGE_THUMBNAIL_GENERATOR, IMAGE_THUMBNAIL_VARIANT } from "../media/images/thumbnail";
import { VIDEO_METADATA_GENERATOR } from "../media/video";
import { boundedMediaRequest } from "../platform/mediaRange";
import { parseRange } from "../platform/range";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";
import { streamLeasedContent } from "./contentStream";
import { loadTargetManifest, manifestContains, type TargetManifestRecord } from "./targetManifest";

/** A current D1 node/blob plan; callers must also check purpose, content session and budget. */
export interface BlobReadPlan {
  readonly key: string;
  readonly size: number;
  readonly r2Etag: string;
  readonly contentEtag: string;
  readonly mime: string;
  readonly name: string;
}

/** Resolve the current file and its physical object under one D1 authorization assertion. */
export async function prepareNodeBlobRead(
  db: D1Database,
  principal: Principal,
  spaceId: string,
  nodeId: string,
): Promise<BlobReadPlan> {
  const authorized = await authorizeNode(db, principal, {
    operation: "node.read",
    spaceId,
    nodeId,
  });
  return resolveBlobRead(db, authorized, []);
}

/** Resolve a blob using an existing request-local node proof. */
export async function prepareAuthorizedNodeBlobRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[] = [],
): Promise<BlobReadPlan> {
  return resolveBlobRead(db, authorized, extra);
}

export async function prepareAuthorizedNodeThumbnailRead(
  db: D1Database,
  authorized: AuthorizedNode,
): Promise<BlobReadPlan> {
  return resolveThumbnailRead(db, authorized, []);
}

export async function prepareAuthorizedNodeTrackRead(
  db: D1Database,
  authorized: AuthorizedNode,
): Promise<BlobReadPlan> {
  return resolveTrackRead(db, authorized, []);
}

export interface ContentBlobGrant {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly purpose: ContentPurpose;
  readonly share?: { readonly id: string; readonly version: number };
}

export interface ContentBlobPlan {
  readonly blob: BlobReadPlan;
  readonly budgetId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly adminAction?: "preview" | "download";
  readonly adminActorId?: string;
  readonly adminOwnerId?: string;
  readonly adminNodeId?: string;
}

/** Resolve the signed host-only cookie to a D1 principal, then apply all content read guards. */
export async function prepareCookieBlobRead(
  db: D1Database,
  bucket: R2Bucket,
  tokens: ContentTokens,
  cookieHeader: string | null,
  spaceId: string,
  nodeId: string,
  purpose: ContentPurpose,
): Promise<ContentBlobPlan> {
  if (!["content", "thumb", "page", "zip", "track"].includes(purpose))
    throw new Error("content_not_available");
  const sessionId = await tokens.verifyCookie(cookieHeader);
  const session = await primary(db)
    .prepare(`SELECT cs.user_id AS userId,cs.share_id AS shareId,
      cs.share_version AS shareVersion,cs.issued_by_credential_id AS credentialId,
      cs.ticket_id AS ticketId,cs.epoch,c.kind AS credentialKind,t.purpose,
      ag.actor_id AS adminActorId,ag.owner_id AS adminOwnerId,
      ag.node_id AS adminNodeId,ag.action AS adminAction
      FROM content_sessions cs JOIN credentials c ON c.id=cs.issued_by_credential_id
      JOIN tickets t ON t.id=cs.ticket_id
      LEFT JOIN admin_content_grants ag ON ag.ticket_id=t.id
      WHERE cs.id=? AND t.purpose=?`)
    .bind(sessionId, purpose)
    .first<{
      userId: string | null;
      shareId: string | null;
      shareVersion: number | null;
      credentialId: string;
      ticketId: string;
      epoch: number;
      credentialKind: string;
      purpose: ContentPurpose;
      adminActorId: string | null;
      adminOwnerId: string | null;
      adminNodeId: string | null;
      adminAction: "preview" | "download" | null;
    }>();
  if (!session) throw new Error("content_not_available");
  let principal: Principal;
  if (
    session.adminAction &&
    session.credentialKind === "access" &&
    session.userId &&
    session.adminActorId === session.userId &&
    session.adminOwnerId &&
    session.adminNodeId === nodeId &&
    purpose === "content"
  ) {
    principal = {
      kind: "admin_read",
      user_id: session.userId,
      owner_id: session.adminOwnerId,
      credential_id: session.credentialId,
      epoch: session.epoch,
    };
  } else if (
    (session.credentialKind === "access" || session.credentialKind === "app_password") &&
    session.userId &&
    !session.adminAction
  ) {
    principal = {
      kind: session.credentialKind === "access" ? "user" : "app_password",
      user_id: session.userId,
      credential_id: session.credentialId,
      epoch: session.epoch,
    };
  } else if (
    session.credentialKind === "share" &&
    session.userId === null &&
    session.shareId &&
    session.shareVersion
  ) {
    principal = {
      kind: "link_share",
      share_id: session.shareId,
      share_version: session.shareVersion,
      credential_id: session.credentialId,
      epoch: session.epoch,
    };
  } else {
    throw new Error("content_not_available");
  }
  const plan = await prepareContentBlobRead(db, bucket, principal, spaceId, nodeId, {
    sessionId,
    ticketId: session.ticketId,
    purpose: session.purpose,
    ...(session.shareId && session.userId && session.shareVersion
      ? { share: { id: session.shareId, version: session.shareVersion } }
      : {}),
  });
  return session.adminAction && session.adminActorId && session.adminOwnerId && session.adminNodeId
    ? Object.freeze({
        ...plan,
        adminAction: session.adminAction,
        adminActorId: session.adminActorId,
        adminOwnerId: session.adminOwnerId,
        adminNodeId: session.adminNodeId,
      })
    : plan;
}

/** Verify the immutable target manifest, then recheck all D1 authority in the blob plan batch. */
export async function prepareContentBlobRead(
  db: D1Database,
  bucket: R2Bucket,
  principal: Principal,
  spaceId: string,
  nodeId: string,
  grant: ContentBlobGrant,
): Promise<ContentBlobPlan> {
  const authorized = await authorizeNode(db, principal, {
    operation: "node.read",
    spaceId,
    nodeId,
  });
  if (
    authorized.operation !== "node.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("content_not_available");
  const record = await primary(db)
    .prepare(`SELECT ts.id,ts.manifest_ref AS ref,ts.manifest_hash AS hash,
      ts.total_bytes AS totalBytes,cs.budget_id AS budgetId
      FROM content_sessions cs JOIN target_sets ts ON ts.id=cs.target_set_id
      JOIN tickets t ON t.target_set_id=ts.id AND t.budget_id=cs.budget_id
      WHERE cs.id=? AND t.id=? AND t.purpose=? AND cs.issued_by_credential_id=?`)
    .bind(grant.sessionId, grant.ticketId, grant.purpose, principal.credential_id)
    .first<TargetManifestRecord & { budgetId: string }>();
  if (!record) throw new Error("content_not_available");
  const manifest = await loadTargetManifest(bucket, record);
  if (
    !manifestContains(manifest, {
      spaceId,
      nodeId,
      blobId: authorized.node.current_blob_id,
      purpose: grant.purpose,
    })
  )
    throw new Error("content_not_available");
  const assertions = [
    contentSessionAssertion(principal, grant.sessionId, grant.ticketId, grant.purpose, grant.share),
    ...(grant.share || principal.kind === "link_share"
      ? [
          shareCoverageAssertion(
            authorized.node,
            grant.share ?? {
              id: principal.kind === "link_share" ? principal.share_id : "",
              version: principal.kind === "link_share" ? principal.share_version : 0,
            },
          ),
        ]
      : []),
    assertExists(
      `SELECT 1 FROM target_sets ts JOIN content_sessions cs ON cs.target_set_id=ts.id
        WHERE cs.id=? AND ts.id=? AND ts.owner_id=? AND ts.manifest_ref=?
          AND ts.manifest_hash=? AND ts.total_bytes=? AND cs.budget_id=?`,
      [
        grant.sessionId,
        record.id,
        authorized.node.owner_id,
        record.ref,
        record.hash,
        record.totalBytes,
        record.budgetId,
      ],
    ),
  ] as const;
  const blob =
    grant.purpose === "content" || grant.purpose === "page"
      ? await resolveBlobRead(db, authorized, assertions)
      : grant.purpose === "track"
        ? await resolveTrackRead(db, authorized, assertions)
        : grant.purpose === "thumb"
          ? await resolveThumbnailRead(db, authorized, assertions)
          : (() => {
              throw new Error("content_not_available");
            })();
  if (
    !manifestContains(manifest, {
      spaceId,
      nodeId,
      blobId: authorized.node.current_blob_id,
      purpose: grant.purpose,
      size: blob.size,
    })
  )
    throw new Error("content_not_available");
  return Object.freeze({
    blob,
    budgetId: record.budgetId,
    sessionId: grant.sessionId,
    epoch: principal.epoch,
  });
}

function reservedResponseBytes(plan: BlobReadPlan, request: Request): number {
  if (request.method !== "GET" && request.method !== "HEAD") throw new Error("invalid_blob_read");
  if (
    request.method === "HEAD" ||
    ifNoneMatch(request.headers.get("If-None-Match"), plan.contentEtag)
  )
    return 0;
  const ifRange = request.headers.get("If-Range");
  const range = parseRange(
    ifRange === null || ifRange === plan.contentEtag ? request.headers.get("Range") : null,
    plan.size,
  );
  return range.kind === "range" ? range.length : range.kind === "unsatisfiable" ? 0 : plan.size;
}

/** Every GET, HEAD, Range and 304 reserves one request before touching R2. */
export async function streamBudgetedContentBlob(
  db: D1Database,
  bucket: R2Bucket,
  budgets: DurableObjectNamespace<BudgetDO>,
  tokens: ContentTokens,
  cookieHeader: string | null,
  spaceId: string,
  nodeId: string,
  purpose: ContentPurpose,
  request: Request,
  auditEnv?: AccountMutationEnv,
): Promise<Response> {
  request.signal.throwIfAborted();
  const plan = await prepareCookieBlobRead(
    db,
    bucket,
    tokens,
    cookieHeader,
    spaceId,
    nodeId,
    purpose,
  );
  if (plan.adminAction) {
    if (!auditEnv) throw new Error("content_not_available");
    const admission = await acquireAccountMutation(
      auditEnv,
      plan.adminOwnerId!,
      plan.epoch,
      "admin.files.read",
    );
    await commitAccountMutation(db, admission, plan.adminOwnerId!, [
      assertExists(
        `SELECT 1 FROM admin_content_grants ag
        JOIN tickets t ON t.id=ag.ticket_id JOIN content_sessions cs ON cs.ticket_id=t.id
        JOIN credentials c ON c.id=cs.issued_by_credential_id AND c.kind='access'
        JOIN sessions s ON s.id=c.session_id AND s.kind='access'
        JOIN users admin ON admin.id=s.user_id
        JOIN nodes n ON n.id=ag.node_id AND n.owner_id=ag.owner_id
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=cs.epoch AND ctl.maintenance=0
        WHERE cs.id=? AND cs.revoked_at IS NULL AND cs.expires_at>strftime('%s','now')*1000
          AND t.cancelled_at IS NULL AND t.expires_at>strftime('%s','now')*1000
          AND ag.actor_id=? AND ag.owner_id=? AND ag.node_id=? AND ag.action=?
          AND n.deleted_at IS NULL AND admin.role='app_admin' AND admin.disabled_at IS NULL
          AND s.user_id=ag.actor_id AND s.epoch=cs.epoch AND s.revoked_at IS NULL
          AND s.expires_at>strftime('%s','now')*1000`,
        [
          plan.sessionId,
          plan.adminActorId!,
          plan.adminOwnerId!,
          plan.adminNodeId!,
          plan.adminAction,
        ],
      ),
      {
        sql: `INSERT INTO admin_browse_audit(id,actor_id,owner_id,node_id,action,occurred_at)
          VALUES(?,?,?,?,?,strftime('%s','now')*1000)`,
        values: [
          crypto.randomUUID(),
          plan.adminActorId!,
          plan.adminOwnerId!,
          plan.adminNodeId!,
          plan.adminAction,
        ],
      },
    ]);
  }
  // Use the same bounded range for admission, R2 and Content-Range. Downloads
  // retain the caller's original request, including an open-ended resume range.
  const deliveryRequest =
    plan.adminAction === "download" ? request : boundedMediaRequest(request, plan.blob);
  const bytes = reservedResponseBytes(plan.blob, deliveryRequest);
  const budget = budgets.get(budgets.idFromName(plan.budgetId));
  const requestId = crypto.randomUUID();
  request.signal.throwIfAborted();
  const lease = await budget.reserve({
    budgetId: plan.budgetId,
    sessionId: plan.sessionId,
    requestId,
    epoch: plan.epoch,
    bytes,
  });
  const streamed = await streamLeasedContent(
    (signal, deadline) =>
      streamImmutableBlob(bucket, plan.blob, deliveryRequest, { signal, deadline }),
    bytes,
    lease.expiresAt,
    request.signal,
    (deliveredBytes) => budget.settle({ budgetId: plan.budgetId, requestId, deliveredBytes }),
  );
  if (plan.adminAction !== "download") return streamed;
  const headers = new Headers(streamed.headers);
  const original = headers.get("Content-Disposition") ?? "attachment";
  headers.set("Content-Disposition", original.replace(/^(?:inline|attachment)/, "attachment"));
  return new Response(streamed.body, { status: streamed.status, headers });
}

async function resolveBlobRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[],
): Promise<BlobReadPlan> {
  if (authorized.operation !== "node.read" || authorized.node.kind !== "file")
    throw new Error("content_not_available");
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT b.r2_key AS key,b.size,s.r2_etag AS r2Etag,
        b.content_etag AS contentEtag,COALESCE(b.mime_sniffed,'application/octet-stream') AS mime,
        n.name FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
        JOIN blob_storage s ON s.blob_id=b.id
        WHERE n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?
          AND n.deleted_at IS NULL AND n.kind='file'
          AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
          AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
          AND s.bytes=b.size AND s.r2_etag IS NOT NULL`,
      values: [
        authorized.node.id,
        authorized.node.space_id,
        authorized.node.revision,
        authorized.node.current_blob_id,
      ],
    },
  ]);
  const row = batches[extra.length + 1]?.results[0] as BlobReadPlan | undefined;
  if (!row) throw new Error("content_not_available");
  validatePlan(row);
  return Object.freeze(row);
}

interface TrackReadRow extends BlobReadPlan {
  readonly container: "mp4" | "webm";
  readonly audioCodec: "opus" | null;
  readonly codecProfile: 0 | 1 | 2;
  readonly codecLevel: number;
  readonly codecTier: "M" | "H";
  readonly bitDepth: 8 | 10 | 12;
}

async function resolveTrackRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[],
): Promise<BlobReadPlan> {
  if (
    authorized.operation !== "node.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("content_not_available");
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT b.r2_key AS key,b.size,s.r2_etag AS r2Etag,b.content_etag AS contentEtag,
        n.name,m.container,m.audio_codec AS audioCodec,m.codec_profile AS codecProfile,
        m.codec_level AS codecLevel,m.codec_tier AS codecTier,m.bit_depth AS bitDepth,
        'application/octet-stream' AS mime
        FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
        JOIN blob_storage s ON s.blob_id=b.id
        JOIN node_media m ON m.node_id=n.id AND m.blob_id=b.id AND m.generator_version=?
        WHERE n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?
          AND n.deleted_at IS NULL AND n.kind='file'
          AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
          AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
          AND s.bytes=b.size AND s.r2_etag IS NOT NULL
          AND m.projection_state='ready' AND m.error_code IS NULL
          AND m.video_codec='av1' AND m.container IN ('mp4','webm')
          AND (m.audio_codec IS NULL OR m.audio_codec='opus')
          AND m.codec_profile BETWEEN 0 AND 2
          AND (m.codec_level BETWEEN 0 AND 23 OR m.codec_level=31)
          AND m.codec_tier IN ('M','H') AND m.bit_depth IN (8,10,12)`,
      values: [
        VIDEO_METADATA_GENERATOR,
        authorized.node.id,
        authorized.node.space_id,
        authorized.node.revision,
        authorized.node.current_blob_id,
      ],
    },
  ]);
  const row = batches[extra.length + 1]?.results[0] as TrackReadRow | undefined;
  if (!row) return resolveAudioTrackRead(db, authorized, extra);
  const plan = {
    key: row.key,
    size: row.size,
    r2Etag: row.r2Etag,
    contentEtag: row.contentEtag,
    name: row.name,
    mime: mediaContentType({
      kind: "video",
      container: row.container,
      codec: "av1",
      configuration: {
        profile: row.codecProfile,
        level: row.codecLevel,
        tier: row.codecTier,
        bitDepth: row.bitDepth,
      },
      audio: row.audioCodec,
    }),
  };
  validatePlan(plan);
  return Object.freeze(plan);
}

async function resolveAudioTrackRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[],
): Promise<BlobReadPlan> {
  if (
    authorized.operation !== "node.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("content_not_available");
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT b.r2_key AS key,b.size,s.r2_etag AS r2Etag,
        b.content_etag AS contentEtag,
        CASE
          WHEN a.codec='mp3' AND b.mime_sniffed='audio/mpeg' THEN 'audio/mpeg'
          WHEN a.codec='opus' AND b.mime_sniffed='audio/ogg' THEN 'audio/ogg; codecs="opus"'
          WHEN a.codec='opus' AND b.mime_sniffed='audio/webm' THEN 'audio/webm; codecs="opus"'
          WHEN a.codec='opus' AND b.mime_sniffed='audio/mp4' THEN 'audio/mp4; codecs="Opus"'
          ELSE 'application/octet-stream'
        END AS mime,
        n.name FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
        JOIN blob_storage s ON s.blob_id=b.id
        JOIN node_audio a ON a.node_id=n.id AND a.blob_id=b.id AND a.generator_version=?
        WHERE n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?
          AND n.deleted_at IS NULL AND n.kind='file'
          AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
          AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
          AND s.bytes=b.size AND s.r2_etag IS NOT NULL
          AND ((a.codec='mp3' AND b.mime_sniffed='audio/mpeg')
            OR (a.codec='opus' AND b.mime_sniffed IN ('audio/ogg','audio/webm','audio/mp4')))`,
      values: [
        AUDIO_GENERATOR_VERSION,
        authorized.node.id,
        authorized.node.space_id,
        authorized.node.revision,
        authorized.node.current_blob_id,
      ],
    },
  ]);
  const row = batches[extra.length + 1]?.results[0] as BlobReadPlan | undefined;
  if (!row) throw new Error("content_not_available");
  validatePlan(row);
  return Object.freeze(row);
}

async function resolveThumbnailRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[],
): Promise<BlobReadPlan> {
  if (
    authorized.operation !== "node.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("content_not_available");
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT d.r2_key AS key,d.size,s.r2_etag AS sourceR2Etag,d.r2_etag AS r2Etag,
        '"thumb-'||d.id||'-'||d.size||'"' AS contentEtag,'image/webp' AS mime,
        'thumbnail.webp' AS name
        FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
        JOIN blob_storage s ON s.blob_id=b.id
        JOIN node_media m ON m.node_id=n.id AND m.blob_id=b.id AND m.generator_version=?
        JOIN derivative_results d ON d.blob_id=b.id
        WHERE n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?
          AND n.deleted_at IS NULL AND n.kind='file'
          AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
          AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
          AND s.bytes=b.size AND s.r2_etag IS NOT NULL
          AND d.kind='thumbnail' AND d.variant=? AND d.generator_version=?
          AND d.state='ready' AND d.epoch=? AND d.size>0
          AND d.r2_key IS NOT NULL AND d.r2_etag IS NOT NULL`,
      values: [
        IMAGE_METADATA_GENERATOR,
        authorized.node.id,
        authorized.node.space_id,
        authorized.node.revision,
        authorized.node.current_blob_id,
        IMAGE_THUMBNAIL_VARIANT,
        IMAGE_THUMBNAIL_GENERATOR,
        authorized.principal.epoch,
      ],
    },
  ]);
  const row = batches[extra.length + 1]?.results[0] as
    | (BlobReadPlan & { sourceR2Etag: string })
    | undefined;
  if (!row || row.sourceR2Etag.length > 256) throw new Error("content_not_available");
  validatePlan(row);
  return Object.freeze({
    key: row.key,
    size: row.size,
    r2Etag: row.r2Etag,
    contentEtag: row.contentEtag,
    mime: row.mime,
    name: row.name,
  });
}

function validatePlan(plan: BlobReadPlan): void {
  if (
    !(
      /^u\/[A-Za-z0-9_-]{1,128}\/b\/[A-Za-z0-9_-]{1,128}$/.test(plan.key) ||
      /^u\/[A-Za-z0-9_-]{1,128}\/d\/[A-Za-z0-9_-]{1,128}\/image-sm256-v1\/sm256\/[0-9a-f-]{36}\.webp$/.test(
        plan.key,
      )
    ) ||
    plan.key.length > 1024 ||
    !Number.isSafeInteger(plan.size) ||
    plan.size < 0 ||
    !plan.r2Etag ||
    plan.r2Etag.length > 256 ||
    !/^"[A-Za-z0-9._:-]{1,200}"$/.test(plan.contentEtag) ||
    !(
      /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(plan.mime) ||
      /^video\/(?:mp4|webm); codecs="av01\.[0-2]\.[0-9]{2}[MH]\.(?:08|10|12)(?:,(?:Opus|opus))?"$/.test(
        plan.mime,
      ) ||
      /^audio\/(?:ogg|webm); codecs="opus"$/.test(plan.mime) ||
      plan.mime === 'audio/mp4; codecs="Opus"'
    ) ||
    !plan.name ||
    new TextEncoder().encode(plan.name).byteLength > 255
  )
    throw new Error("invalid_blob_read");
}

function ifNoneMatch(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

function safeInline(mime: string): boolean {
  return (
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf"
  );
}

function responseHeaders(plan: BlobReadPlan, etag = plan.contentEtag): Headers {
  const disposition = safeInline(plan.mime) ? "inline" : "attachment";
  const encodedName = encodeURIComponent(plan.name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
    "Content-Type": plan.mime,
    ETag: etag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

/** Streaming primitive; caller must prove current D1 authority and reserve the content budget. */
export async function streamImmutableBlob(
  bucket: R2Bucket,
  plan: BlobReadPlan,
  request: Request,
  options: {
    readonly etag?: string;
    readonly signal?: AbortSignal;
    readonly deadline?: number;
  } = {},
): Promise<Response> {
  const signal = options.signal ?? request.signal;
  const active = () => {
    signal.throwIfAborted();
    if (options.deadline !== undefined && Date.now() >= options.deadline)
      throw new Error("content_lease_expired");
  };
  active();
  validatePlan(plan);
  if (request.method !== "GET" && request.method !== "HEAD") throw new Error("invalid_blob_read");
  const etag = options.etag ?? plan.contentEtag;
  if (!/^"[\x21\x23-\x7e]{1,512}"$/.test(etag)) throw new Error("invalid_blob_read");
  const object = await bucket.head(plan.key);
  active();
  if (!object || object.size !== plan.size || object.etag !== plan.r2Etag)
    throw new Error("blob_storage_mismatch");
  const headers = responseHeaders(plan, etag);
  if (ifNoneMatch(request.headers.get("If-None-Match"), etag))
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(plan.size));
    return new Response(null, { status: 200, headers });
  }
  const ifRange = request.headers.get("If-Range");
  const range = parseRange(
    ifRange === null || ifRange === etag ? request.headers.get("Range") : null,
    plan.size,
  );
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${plan.size}`);
    return new Response(null, { status: 416, headers });
  }
  const body = await bucket.get(
    plan.key,
    range.kind === "range" ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  try {
    active();
  } catch (error) {
    void body?.body.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!body || body.etag !== plan.r2Etag || body.size !== plan.size) {
    void body?.body.cancel().catch(() => undefined);
    throw new Error("blob_storage_mismatch");
  }
  if (range.kind === "range") {
    if (
      !body.range ||
      !("offset" in body.range) ||
      !("length" in body.range) ||
      body.range.offset !== range.offset ||
      body.range.length !== range.length
    ) {
      void body.body.cancel().catch(() => undefined);
      throw new Error("blob_range_mismatch");
    }
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${plan.size}`,
    );
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(plan.size));
  }
  return new Response(body.body, { status: range.kind === "range" ? 206 : 200, headers });
}
