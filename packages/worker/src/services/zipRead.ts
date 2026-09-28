import { problem } from "@next-cloud-flare/shared/errors";
import { authorizeNode, type Principal } from "../auth/authorize";
import { contentSessionAssertion } from "../auth/contentSession";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { storeZip } from "../platform/storeZip";
import { streamLeasedContent } from "./contentStream";
import { loadTargetManifest, type TargetManifestRecord } from "./targetManifest";
import { zipPinsAssertion } from "./zipPins";
import { zipSnapshotAssertions } from "./zipSnapshot";

interface ZipGrant extends TargetManifestRecord {
  sessionId: string;
  budgetId: string;
  ownerId: string;
  expiresAt: number;
  sessionExpiresAt: number;
  shareId: string | null;
  shareVersion: number | null;
}
interface ZipBlob {
  id: string;
  key: string;
  size: number;
  etag: string;
}

function headers(name: string, size: number) {
  const filename = `${name || "files"}.zip`;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "Content-Type": "application/zip",
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="download.zip"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "none",
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
  });
}

/** One GET authorizes the whole fixed snapshot; pins preserve those bytes through the lease deadline. */
export async function streamZipTicket(
  env: Pick<Env, "DB" | "BLOBS" | "BUDGETS">,
  principal: Principal,
  ticketId: string,
  request: Request,
): Promise<Response> {
  if (
    principal.kind === "service" ||
    request.method !== "GET" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(ticketId)
  )
    throw new Error("zip_unavailable");
  request.signal.throwIfAborted();
  const grant = await primary(env.DB)
    .prepare(`SELECT ts.id,ts.manifest_ref AS ref,ts.manifest_hash AS hash,
      ts.total_bytes AS totalBytes,ts.owner_id AS ownerId,ts.expires_at AS expiresAt,
      cs.id AS sessionId,cs.budget_id AS budgetId,cs.expires_at AS sessionExpiresAt,
      cs.share_id AS shareId,cs.share_version AS shareVersion
    FROM tickets t JOIN content_sessions cs ON cs.ticket_id=t.id
    JOIN target_sets ts ON ts.id=t.target_set_id AND ts.id=cs.target_set_id
    WHERE t.id=? AND t.purpose='zip' AND t.credential_id=? AND cs.issued_by_credential_id=t.credential_id
      AND ts.credential_id=t.credential_id AND t.epoch=? AND cs.epoch=t.epoch AND ts.epoch=t.epoch
      AND cs.revoked_at IS NULL AND t.cancelled_at IS NULL
      AND cs.expires_at>strftime('%s','now')*1000 AND ts.expires_at>=cs.expires_at
      AND t.expires_at>=cs.expires_at ORDER BY cs.issued_at DESC,cs.id LIMIT 1`)
    .bind(ticketId, principal.credential_id, principal.epoch)
    .first<ZipGrant>();
  if (!grant) throw new Error("zip_unavailable");
  const share =
    principal.kind !== "link_share" && grant.shareId !== null && grant.shareVersion !== null
      ? { id: grant.shareId, version: grant.shareVersion }
      : undefined;
  if (principal.kind !== "link_share" && share) principal = { ...principal, selected_share: share };
  const session = contentSessionAssertion(principal, grant.sessionId, ticketId, "zip", share);
  await atomicBatch(env.DB, [session]);
  const manifest = await loadTargetManifest(env.BLOBS, grant);
  if (manifest.v !== 2) throw new Error("zip_unavailable");
  const proof = await authorizeNode(env.DB, principal, {
    operation: "node.read",
    nodeId: manifest.zip.rootNodeId,
    spaceId: manifest.zip.spaceId,
  });
  if (proof.operation !== "node.read" || proof.node.owner_id !== grant.ownerId)
    throw new Error("zip_unavailable");
  const guards = [
    session,
    ...zipSnapshotAssertions(proof as typeof proof & { operation: "node.read" }, manifest),
    zipPinsAssertion(manifest, grant.id, grant.expiresAt),
    assertExists(
      `SELECT 1 FROM target_sets WHERE id=? AND owner_id=? AND credential_id=? AND epoch=?
      AND manifest_ref=? AND manifest_hash=? AND total_bytes=? AND expires_at=?`,
      [
        grant.id,
        grant.ownerId,
        principal.credential_id,
        principal.epoch,
        grant.ref,
        grant.hash,
        grant.totalBytes,
        grant.expiresAt,
      ],
    ),
  ];
  const result = await atomicBatch(env.DB, [
    ...guards,
    {
      sql: `SELECT DISTINCT b.id,b.r2_key AS key,b.size,s.r2_etag AS etag FROM json_each(?1) e
      JOIN blobs b ON b.id=json_extract(e.value,'$.blobId') JOIN blob_storage s ON s.blob_id=b.id
      WHERE b.owner_id=?2 AND s.removed_at IS NULL AND s.bytes=b.size AND s.r2_etag IS NOT NULL`,
      values: [JSON.stringify(manifest.targets), grant.ownerId],
    },
  ]);
  const blobs = new Map(
    (result[result.length - 1]!.results as unknown as ZipBlob[]).map((blob) => [blob.id, blob]),
  );
  if (blobs.size !== new Set(manifest.targets.map((target) => target.blobId)).size)
    throw new Error("zip_unavailable");
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(grant.budgetId));
  const requestId = crypto.randomUUID(),
    ranged = request.headers.has("Range");
  request.signal.throwIfAborted();
  const lease = await budget.reserve({
    budgetId: grant.budgetId,
    sessionId: grant.sessionId,
    requestId,
    epoch: principal.epoch,
    bytes: ranged ? 0 : grant.totalBytes,
  });
  return streamLeasedContent(
    async (signal, deadline) => {
      signal.throwIfAborted();
      await atomicBatch(env.DB, guards);
      signal.throwIfAborted();
      if (ranged) {
        const response = problem(416, "range_not_satisfiable");
        response.headers.set("Content-Range", `bytes */${grant.totalBytes}`);
        response.headers.set("Accept-Ranges", "none");
        // A rejected range still counts as a request, with zero delivered archive bytes.
        return new Response(null, { status: 416, headers: response.headers });
      }
      const archive = storeZip(
        manifest.zip.entries.map((entry) => ({
          name: entry.path,
          directory: entry.kind === "folder",
          size: entry.size,
          open: async () => {
            signal.throwIfAborted();
            if (Date.now() >= deadline) throw new Error("content_lease_expired");
            const blob = blobs.get(entry.blobId!);
            if (!blob) throw new Error("zip_unavailable");
            const object = await env.BLOBS.get(blob.key);
            try {
              signal.throwIfAborted();
              if (Date.now() >= deadline) throw new Error("content_lease_expired");
              if (!object || object.size !== blob.size || object.etag !== blob.etag)
                throw new Error("blob_storage_mismatch");
              return object.body;
            } catch (error) {
              void object?.body.cancel(error).catch(() => undefined);
              throw error;
            }
          },
        })),
      );
      if (archive.size !== grant.totalBytes) {
        void archive.body.cancel().catch(() => undefined);
        throw new Error("invalid_zip_manifest");
      }
      return new Response(archive.body, { headers: headers(proof.node.name, archive.size) });
    },
    ranged ? 0 : grant.totalBytes,
    Math.min(lease.expiresAt, grant.expiresAt, grant.sessionExpiresAt),
    request.signal,
    (deliveredBytes) => budget.settle({ budgetId: grant.budgetId, requestId, deliveredBytes }),
  );
}
