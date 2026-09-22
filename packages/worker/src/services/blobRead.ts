import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { type ContentPurpose, contentSessionAssertion } from "../auth/contentSession";
import type { ContentTokens } from "../auth/contentTokens";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { BudgetDO } from "../do/BudgetDO";
import { parseRange } from "../platform/range";
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
  const sessionId = await tokens.verifyCookie(cookieHeader);
  const session = await primary(db)
    .prepare(`SELECT cs.user_id AS userId,cs.share_id AS shareId,
      cs.share_version AS shareVersion,cs.issued_by_credential_id AS credentialId,
      cs.ticket_id AS ticketId,cs.epoch,c.kind AS credentialKind
      FROM content_sessions cs JOIN credentials c ON c.id=cs.issued_by_credential_id
      JOIN tickets t ON t.id=cs.ticket_id
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
    }>();
  if (!session) throw new Error("content_not_available");
  let principal: Principal;
  if (
    (session.credentialKind === "access" || session.credentialKind === "app_password") &&
    session.userId
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
  return prepareContentBlobRead(db, bucket, principal, spaceId, nodeId, {
    sessionId,
    ticketId: session.ticketId,
    purpose,
    ...(session.shareId && session.userId && session.shareVersion
      ? { share: { id: session.shareId, version: session.shareVersion } }
      : {}),
  });
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
  const blob = await resolveBlobRead(db, authorized, [
    contentSessionAssertion(principal, grant.sessionId, grant.ticketId, grant.purpose, grant.share),
    ...(grant.share || principal.kind === "link_share"
      ? [
          assertExists(
            `WITH RECURSIVE a(id,parent_id,depth,path) AS (
              SELECT id,parent_id,0,'/'||id||'/' FROM nodes
                WHERE id=? AND space_id=? AND owner_id=?
              UNION ALL
              SELECT n.id,n.parent_id,a.depth+1,a.path||n.id||'/'
                FROM nodes n JOIN a ON n.id=a.parent_id
                WHERE a.depth<64 AND n.space_id=? AND n.owner_id=?
                  AND instr(a.path,'/'||n.id||'/')=0
            ) SELECT 1 FROM shares sh JOIN a ON a.id=sh.root_node_id
              WHERE sh.id=? AND sh.version=? AND sh.owner_id=?
                AND sh.disabled_at IS NULL
                AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
                AND EXISTS(SELECT 1 FROM share_actions sa
                  WHERE sa.share_id=sh.id AND sa.action='read')`,
            [
              authorized.node.id,
              authorized.node.space_id,
              authorized.node.owner_id,
              authorized.node.space_id,
              authorized.node.owner_id,
              grant.share?.id ?? (principal.kind === "link_share" ? principal.share_id : ""),
              grant.share?.version ??
                (principal.kind === "link_share" ? principal.share_version : 0),
              authorized.node.owner_id,
            ],
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
  ]);
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
): Promise<Response> {
  const plan = await prepareCookieBlobRead(
    db,
    bucket,
    tokens,
    cookieHeader,
    spaceId,
    nodeId,
    purpose,
  );
  const bytes = reservedResponseBytes(plan.blob, request);
  const budget = budgets.get(budgets.idFromName(plan.budgetId));
  const requestId = crypto.randomUUID();
  await budget.reserve({
    budgetId: plan.budgetId,
    sessionId: plan.sessionId,
    requestId,
    epoch: plan.epoch,
    bytes,
  });
  let response: Response;
  try {
    response = await streamImmutableBlob(bucket, plan.blob, request);
  } catch (error) {
    await budget.settle({ budgetId: plan.budgetId, requestId, deliveredBytes: 0 });
    throw error;
  }
  if (!response.body) {
    await budget.settle({ budgetId: plan.budgetId, requestId, deliveredBytes: 0 });
    return response;
  }
  const reader = response.body.getReader();
  let delivered = 0;
  let terminal = false;
  const settle = async (known: boolean) => {
    if (terminal) return;
    terminal = true;
    await budget.settle({
      budgetId: plan.budgetId,
      requestId,
      deliveredBytes: known ? delivered : null,
    });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (delivered !== bytes) throw new Error("blob_stream_length_mismatch");
          await settle(true);
          controller.close();
          return;
        }
        if (delivered + next.value.byteLength > bytes)
          throw new Error("blob_stream_length_mismatch");
        delivered += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        await settle(false).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await settle(false);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
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

function validatePlan(plan: BlobReadPlan): void {
  if (
    !/^u\/[A-Za-z0-9_-]{1,128}\/b\/[A-Za-z0-9_-]{1,128}$/.test(plan.key) ||
    plan.key.length > 1024 ||
    !Number.isSafeInteger(plan.size) ||
    plan.size < 0 ||
    !plan.r2Etag ||
    plan.r2Etag.length > 256 ||
    !/^"[A-Za-z0-9._:-]{1,200}"$/.test(plan.contentEtag) ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(plan.mime) ||
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

function responseHeaders(plan: BlobReadPlan): Headers {
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
    ETag: plan.contentEtag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

/** Streaming primitive; caller must prove current D1 authority and reserve the content budget. */
export async function streamImmutableBlob(
  bucket: R2Bucket,
  plan: BlobReadPlan,
  request: Request,
): Promise<Response> {
  validatePlan(plan);
  if (request.method !== "GET" && request.method !== "HEAD") throw new Error("invalid_blob_read");
  const object = await bucket.head(plan.key);
  if (!object || object.size !== plan.size || object.etag !== plan.r2Etag)
    throw new Error("blob_storage_mismatch");
  const headers = responseHeaders(plan);
  if (ifNoneMatch(request.headers.get("If-None-Match"), plan.contentEtag))
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(plan.size));
    return new Response(null, { status: 200, headers });
  }
  const ifRange = request.headers.get("If-Range");
  const range = parseRange(
    ifRange === null || ifRange === plan.contentEtag ? request.headers.get("Range") : null,
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
  if (!body || body.etag !== plan.r2Etag || body.size !== plan.size)
    throw new Error("blob_storage_mismatch");
  if (range.kind === "range") {
    if (
      !body.range ||
      !("offset" in body.range) ||
      !("length" in body.range) ||
      body.range.offset !== range.offset ||
      body.range.length !== range.length
    )
      throw new Error("blob_range_mismatch");
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
