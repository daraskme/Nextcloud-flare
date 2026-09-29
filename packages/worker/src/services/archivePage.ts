import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { contentSessionAssertion } from "../auth/contentSession";
import type { ContentTokens } from "../auth/contentTokens";
import { shareCoverageAssertion } from "../auth/shareCoverage";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { BudgetDO } from "../do/BudgetDO";
import { openArchiveEntry } from "../media/archive/entry";
import { ARCHIVE_LIMITS } from "../media/archive/format";
import { identifyPageImage } from "../media/archive/pageImage";
import { archiveObjectSource } from "../media/archive/r2Source";
import { prepareAuthorizedArchiveRead } from "./archiveRead";
import { type ContentBlobGrant, cookieContentGrant } from "./blobRead";
import { streamLeasedContent } from "./contentStream";
import { loadTargetManifest, type TargetManifestRecord } from "./targetManifest";

export async function streamCookieArchivePage(
  db: D1Database,
  bucket: R2Bucket,
  budgets: DurableObjectNamespace<BudgetDO>,
  tokens: ContentTokens,
  spaceId: string,
  nodeId: string,
  blobId: string,
  page: number,
  request: Request,
  attachment: boolean,
) {
  const { principal, grant } = await cookieContentGrant(
    db,
    tokens,
    request.headers.get("Cookie"),
    "page",
  );
  return streamArchivePage(
    db,
    bucket,
    budgets,
    principal,
    grant,
    spaceId,
    nodeId,
    blobId,
    page,
    request,
    attachment,
  );
}

/** Page numbers are one based natural image order, never paths or ZIP entry ordinals. */
export async function streamArchivePage(
  db: D1Database,
  bucket: R2Bucket,
  budgets: DurableObjectNamespace<BudgetDO>,
  principal: Principal,
  grant: ContentBlobGrant,
  spaceId: string,
  nodeId: string,
  blobId: string,
  page: number,
  request: Request,
  attachment: boolean,
) {
  if (
    grant.purpose !== "page" ||
    grant.variant !== undefined ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > ARCHIVE_LIMITS.entries ||
    !["GET", "HEAD"].includes(request.method)
  )
    throw new Error("content_not_available");
  request.signal.throwIfAborted();
  const proof = await authorizeNode(db, principal, { operation: "library.read", spaceId, nodeId });
  if (proof.operation !== "library.read" || proof.node.current_blob_id !== blobId)
    throw new Error("content_not_available");
  const session = contentSessionAssertion(
    principal,
    grant.sessionId,
    grant.ticketId,
    "page",
    grant.share,
  );
  await atomicBatch(db, [authorizationAssertion(proof), session]);
  const record = await primary(db)
    .prepare(`SELECT ts.id,ts.manifest_ref AS ref,ts.manifest_hash AS hash,
    ts.total_bytes AS totalBytes,cs.budget_id AS budgetId FROM content_sessions cs
    JOIN target_sets ts ON ts.id=cs.target_set_id JOIN tickets t ON t.id=cs.ticket_id
    AND t.target_set_id=ts.id AND t.budget_id=cs.budget_id
    WHERE cs.id=? AND t.id=? AND t.purpose='page' AND cs.issued_by_credential_id=?`)
    .bind(grant.sessionId, grant.ticketId, principal.credential_id)
    .first<TargetManifestRecord & { budgetId: string }>();
  if (!record) throw new Error("content_not_available");
  const manifest = await loadTargetManifest(bucket, record);
  if (manifest.v !== 4) throw new Error("content_not_available");
  const target = manifest.targets[0];
  if (page > target.pageCount) throw new Error("content_not_available");
  const guards = [
    session,
    ...(grant.share || principal.kind === "link_share"
      ? [
          shareCoverageAssertion(
            proof.node,
            grant.share ?? {
              id: principal.kind === "link_share" ? principal.share_id : "",
              version: principal.kind === "link_share" ? principal.share_version : 0,
            },
          ),
        ]
      : []),
    assertExists(
      `SELECT 1 FROM target_sets ts JOIN content_sessions cs ON cs.target_set_id=ts.id
      WHERE cs.id=? AND ts.id=? AND ts.owner_id=? AND ts.manifest_ref=? AND ts.manifest_hash=? AND ts.total_bytes=? AND cs.budget_id=?`,
      [
        grant.sessionId,
        record.id,
        proof.node.owner_id,
        record.ref,
        record.hash,
        record.totalBytes,
        record.budgetId,
      ],
    ),
  ];
  const plan = await prepareAuthorizedArchiveRead(db, proof, guards, target);
  const etag = `"page-${target.indexHash}-${page}"`;
  const unchanged =
    request.headers
      .get("If-None-Match")
      ?.split(",")
      .some((s) => ["*", etag, `W/${etag}`].includes(s.trim())) ?? false;
  const size = target.pageBytes[page - 1]!,
    bytes = request.method === "HEAD" || unchanged ? 0 : size;
  const budget = budgets.get(budgets.idFromName(record.budgetId)),
    requestId = crypto.randomUUID();
  const lease = await budget.reserve({
    budgetId: record.budgetId,
    sessionId: grant.sessionId,
    requestId,
    epoch: principal.epoch,
    bytes,
  });
  return streamLeasedContent(
    async (signal, deadline) => {
      const checkpoint = async () => {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("content_lease_expired");
        await plan.authorize();
        signal.throwIfAborted();
      };
      const { index } = await plan.load(bucket, signal);
      const source = archiveObjectSource(bucket, plan.original, signal, checkpoint, {
        reads: 0,
        bytes: 0,
        maxReads: 5,
        maxBytes: ARCHIVE_LIMITS.compressedBytes + 67_000,
      });
      const ordinal = index.pages[page - 1]!,
        entry = index.entries[ordinal]!;
      const image = await identifyPageImage(
        await openArchiveEntry(source, index, ordinal, checkpoint),
        size,
        checkpoint,
      );
      const extension = image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6);
      // Do not put an untrusted archive path or extension into response headers.
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Content-Type": image.mime,
        "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="page-${page}.${extension}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "none",
        ETag: etag,
      });
      if (unchanged || request.method === "HEAD") {
        void image.body.cancel().catch(() => undefined);
        if (!unchanged) headers.set("Content-Length", String(entry.size));
        return new Response(null, { status: unchanged ? 304 : 200, headers });
      }
      headers.set("Content-Length", String(entry.size));
      return new Response(image.body, { headers });
    },
    bytes,
    lease.expiresAt,
    request.signal,
    (deliveredBytes) => budget.settle({ budgetId: record.budgetId, requestId, deliveredBytes }),
  );
}
