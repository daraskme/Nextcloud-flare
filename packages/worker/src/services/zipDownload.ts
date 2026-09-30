import { LIMITS } from "@next-cloud-flare/shared/limits";
import { portableName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationBatchAssertions,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { contentSessionAssertion } from "../auth/contentSession";
import type { ContentTokens } from "../auth/contentTokens";
import { shareCoverageBatchAssertions } from "../auth/shareCoverage";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { BudgetDO } from "../do/BudgetDO";
import { storeZip, storeZipSize } from "../platform/storeZip";
import { type BlobReadPlan, prepareAuthorizedNodeBlobRead } from "./blobRead";
import { streamLeasedContent } from "./contentStream";
import {
  loadTargetManifest,
  type TargetManifestRecord,
  type ZipTargetEntry,
} from "./targetManifest";

const SUBTREE = `WITH RECURSIVE tree(
  id,parent_id,name,kind,depth,node_path,archive_components
) AS (
  SELECT id,parent_id,name,kind,0,'/'||id||'/',json_array(name)
    FROM nodes
    WHERE id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id,n.parent_id,n.name,n.kind,t.depth+1,t.node_path||n.id||'/',
    json_insert(t.archive_components,'$[#]',n.name)
    FROM nodes n JOIN tree t ON n.parent_id=t.id
    WHERE t.depth<64 AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
      AND instr(t.node_path,'/'||n.id||'/')=0
)
SELECT id,archive_components AS components,NULL AS issue FROM tree WHERE kind='file'
UNION ALL
SELECT '', '[]', 'depth' WHERE EXISTS(
  SELECT 1 FROM tree t JOIN nodes n ON n.parent_id=t.id
    WHERE t.depth=64 AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?)
UNION ALL
SELECT '', '[]', 'cycle' WHERE EXISTS(
  SELECT 1 FROM tree t JOIN nodes n ON n.parent_id=t.id
    WHERE n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
      AND instr(t.node_path,'/'||n.id||'/')<>0)
UNION ALL
SELECT '', '[]', 'ownership' WHERE EXISTS(
  SELECT 1 FROM tree t JOIN nodes n ON n.parent_id=t.id
    WHERE n.deleted_at IS NULL AND (n.space_id<>? OR n.owner_id<>?))
ORDER BY issue DESC,components,id
LIMIT ?`;

const OVERLAP = `WITH RECURSIVE
  selected(space_id,node_id) AS (
    SELECT json_extract(value,'$.spaceId'),json_extract(value,'$.nodeId') FROM json_each(?)
  ),
  ancestors(root_space,root_id,id,parent_id,depth,path) AS (
    SELECT s.space_id,s.node_id,n.id,n.parent_id,0,'/'||n.id||'/'
      FROM selected s JOIN nodes n ON n.id=s.node_id AND n.space_id=s.space_id
    UNION ALL
    SELECT a.root_space,a.root_id,n.id,n.parent_id,a.depth+1,a.path||n.id||'/'
      FROM ancestors a JOIN nodes n ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=a.root_space AND instr(a.path,'/'||n.id||'/')=0
  )
SELECT 1 FROM ancestors a JOIN selected s
  ON s.space_id=a.root_space AND s.node_id=a.id
  WHERE a.depth>0 LIMIT 1`;

const PATH_ASSERTION = `WITH RECURSIVE a(id,parent_id,name,depth,path,node_path) AS (
  SELECT id,parent_id,name,0,name,'/'||id||'/' FROM nodes
    WHERE id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id,n.parent_id,n.name,a.depth+1,n.name||'/'||a.path,a.node_path||n.id||'/'
    FROM nodes n JOIN a ON n.id=a.parent_id
    WHERE a.id<>? AND a.depth<64 AND n.space_id=? AND n.owner_id=?
      AND n.deleted_at IS NULL AND instr(a.node_path,'/'||n.id||'/')=0
) SELECT 1 FROM a WHERE id=? AND path=?`;

const AUTHORITY_POLL_MS = 1_000;

export interface ZipSelection {
  readonly spaceId: string;
  readonly nodeId: string;
}

export interface ZipPlan {
  readonly ownerId: string;
  readonly entries: readonly ZipTargetEntry[];
  readonly proofs: readonly AuthorizedNode[];
  readonly outputSize: number;
}

interface Candidate {
  readonly rootId: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly path: string;
  readonly proof?: AuthorizedNode;
}

function checkedComponents(input: readonly string[]): { path: string; folded: string } {
  if (input.length === 0) throw new Error("zip_path_invalid");
  const components = input.map((component) => portableName(component));
  const path = components.map((component) => component.name).join("/");
  if (path.length === 0 || new TextEncoder().encode(path).byteLength > LIMITS.zipPathBytes)
    throw new Error("zip_path_invalid");
  return { path, folded: components.map((component) => component.nameCi).join("/") };
}

function checkedPath(input: string): { path: string; folded: string } {
  return checkedComponents(input.normalize("NFC").split("/"));
}

/** Expand and authorize a bounded ZIP plan before any ticket is published. */
export async function planZipDownload(
  db: D1Database,
  bucket: R2Bucket,
  principal: Principal,
  selections: readonly ZipSelection[],
): Promise<ZipPlan> {
  if (selections.length === 0 || selections.length > LIMITS.zipEntries)
    throw new Error("zip_selection_invalid");
  const selected = new Set<string>();
  const roots: AuthorizedNode[] = [];
  let ownerId: string | undefined;
  let spaceId: string | undefined;
  for (const selection of selections) {
    const key = `${selection.spaceId}/${selection.nodeId}`;
    if (selected.has(key)) throw new Error("zip_selection_overlap");
    selected.add(key);
    const proof = await authorizeNode(db, principal, {
      operation: "node.read",
      spaceId: selection.spaceId,
      nodeId: selection.nodeId,
    });
    if (
      proof.operation !== "node.read" ||
      proof.node.kind === "root" ||
      (ownerId !== undefined && proof.node.owner_id !== ownerId) ||
      (spaceId !== undefined && proof.node.space_id !== spaceId)
    )
      throw new Error("zip_selection_invalid");
    ownerId = proof.node.owner_id;
    spaceId = proof.node.space_id;
    roots.push(proof);
  }
  if (!ownerId || !spaceId) throw new Error("zip_selection_invalid");
  if (await primary(db).prepare(OVERLAP).bind(JSON.stringify(selections)).first<number>())
    throw new Error("zip_selection_overlap");

  const candidates: Candidate[] = [];
  for (const proof of roots) {
    if (proof.operation !== "node.read") throw new Error("zip_selection_invalid");
    if (proof.node.kind === "file") {
      candidates.push({
        rootId: proof.node.id,
        spaceId: proof.node.space_id,
        nodeId: proof.node.id,
        path: checkedComponents([proof.node.name]).path,
        proof,
      });
      continue;
    }
    const result = await primary(db)
      .prepare(SUBTREE)
      .bind(
        proof.node.id,
        proof.node.space_id,
        proof.node.owner_id,
        proof.node.space_id,
        proof.node.owner_id,
        proof.node.space_id,
        proof.node.owner_id,
        proof.node.space_id,
        proof.node.owner_id,
        proof.node.space_id,
        proof.node.owner_id,
        LIMITS.zipEntries + 4,
      )
      .all<{ id: string; components: string; issue: string | null }>();
    if (result.results.some((row) => row.issue !== null)) throw new Error("zip_tree_invalid");
    for (const row of result.results) {
      let components: unknown;
      try {
        components = JSON.parse(row.components);
      } catch {
        throw new Error("zip_tree_invalid");
      }
      if (
        !Array.isArray(components) ||
        components.length === 0 ||
        components.some((component) => typeof component !== "string")
      )
        throw new Error("zip_tree_invalid");
      candidates.push({
        rootId: proof.node.id,
        spaceId: proof.node.space_id,
        nodeId: row.id,
        path: checkedComponents(components).path,
      });
    }
    if (candidates.length > LIMITS.zipEntries) throw new Error("zip_entry_limit");
  }
  if (candidates.length === 0 || candidates.length > LIMITS.zipEntries)
    throw new Error("zip_entry_limit");
  candidates.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : left.nodeId < right.nodeId ? -1 : 1,
  );

  const nodeIds = new Set<string>();
  const blobIds = new Set<string>();
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const entries: ZipTargetEntry[] = [];
  const proofs: AuthorizedNode[] = [];
  for (const candidate of candidates) {
    if (nodeIds.has(candidate.nodeId)) throw new Error("zip_selection_overlap");
    nodeIds.add(candidate.nodeId);
    const path = checkedPath(candidate.path);
    if (paths.has(path.path) || foldedPaths.has(path.folded)) throw new Error("zip_path_collision");
    paths.add(path.path);
    foldedPaths.add(path.folded);
    const proof =
      candidate.proof ??
      (await authorizeNode(db, principal, {
        operation: "node.read",
        spaceId: candidate.spaceId,
        nodeId: candidate.nodeId,
      }));
    if (
      proof.operation !== "node.read" ||
      proof.node.kind !== "file" ||
      !proof.node.current_blob_id ||
      proof.node.owner_id !== ownerId ||
      proof.node.space_id !== spaceId ||
      blobIds.has(proof.node.current_blob_id)
    )
      throw new Error("zip_target_unavailable");
    blobIds.add(proof.node.current_blob_id);
    const blob = await prepareAuthorizedNodeBlobRead(db, proof);
    if (blob.size > LIMITS.zipEntryBytes) throw new Error("zip_entry_limit");
    const object = await bucket.head(blob.key);
    if (!object || object.size !== blob.size || object.etag !== blob.r2Etag)
      throw new Error("blob_storage_mismatch");
    entries.push({
      path: path.path,
      rootId: candidate.rootId,
      spaceId: proof.node.space_id,
      nodeId: proof.node.id,
      blobId: proof.node.current_blob_id,
      size: blob.size,
      r2Etag: blob.r2Etag,
    });
    proofs.push(proof);
  }
  const outputSize = storeZipSize(
    entries.map((entry) => ({
      name: entry.path,
      size: entry.size,
      open: async () => {
        throw new Error("zip_measure_open");
      },
    })),
  );
  return Object.freeze({
    ownerId,
    entries: Object.freeze(entries),
    proofs: Object.freeze(proofs),
    outputSize,
  });
}

/** Pin current path components in the same D1 batch as target-set publication. */
export function zipPathBatchAssertions(
  entries: readonly ZipTargetEntry[],
  ownerId: string,
): readonly SqlStatement[] {
  if (entries.length === 0 || entries.length > LIMITS.zipEntries)
    throw new Error("invalid_zip_path_assertions");
  const statements: SqlStatement[] = [];
  for (let start = 0; start < entries.length; start += 12) {
    const group = entries.slice(start, start + 12);
    const values = group.flatMap((entry) => [
      entry.nodeId,
      entry.spaceId,
      ownerId,
      entry.rootId,
      entry.spaceId,
      ownerId,
      entry.rootId,
      entry.path,
    ]);
    statements.push({
      sql: `INSERT INTO _assert(v) SELECT 1 WHERE NOT (${group
        .map(() => `EXISTS (${PATH_ASSERTION})`)
        .join(" AND ")})`,
      values,
    });
  }
  return statements;
}

interface ZipContentPlan {
  readonly budgetId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly outputSize: number;
  readonly manifestHash: string;
  readonly targetSetId: string;
  readonly ticketId: string;
  readonly principal: Principal;
  readonly share: { readonly id: string; readonly version: number } | undefined;
  readonly sources: readonly {
    readonly entry: ZipTargetEntry;
    readonly blob: BlobReadPlan;
  }[];
}

async function prepareZipContent(
  db: D1Database,
  bucket: R2Bucket,
  tokens: ContentTokens,
  cookieHeader: string | null,
  targetSetId: string,
): Promise<ZipContentPlan> {
  const sessionId = await tokens.verifyCookie(cookieHeader);
  const record = await primary(db)
    .prepare(`SELECT cs.user_id AS userId,cs.share_id AS shareId,
      cs.share_version AS shareVersion,cs.issued_by_credential_id AS credentialId,
      cs.ticket_id AS ticketId,cs.epoch,c.kind AS credentialKind,
      cs.budget_id AS budgetId,ts.id,ts.owner_id AS ownerId,ts.manifest_ref AS ref,
      ts.manifest_hash AS hash,ts.total_bytes AS totalBytes
      FROM content_sessions cs JOIN credentials c ON c.id=cs.issued_by_credential_id
      JOIN tickets t ON t.id=cs.ticket_id AND t.target_set_id=cs.target_set_id
      JOIN target_sets ts ON ts.id=cs.target_set_id
      WHERE cs.id=? AND cs.target_set_id=? AND t.purpose='zip'`)
    .bind(sessionId, targetSetId)
    .first<
      TargetManifestRecord & {
        userId: string | null;
        shareId: string | null;
        shareVersion: number | null;
        credentialId: string;
        ticketId: string;
        epoch: number;
        credentialKind: string;
        budgetId: string;
        ownerId: string;
      }
    >();
  if (!record) throw new Error("content_not_available");
  let principal: Principal;
  if (
    (record.credentialKind === "access" || record.credentialKind === "app_password") &&
    record.userId
  ) {
    principal = {
      kind: record.credentialKind === "access" ? "user" : "app_password",
      user_id: record.userId,
      credential_id: record.credentialId,
      epoch: record.epoch,
    };
  } else if (
    record.credentialKind === "share" &&
    record.shareId &&
    record.shareVersion !== null &&
    Number.isSafeInteger(record.shareVersion) &&
    record.shareVersion > 0
  ) {
    principal = {
      kind: "link_share",
      share_id: record.shareId,
      share_version: record.shareVersion,
      credential_id: record.credentialId,
      epoch: record.epoch,
    };
  } else {
    throw new Error("content_not_available");
  }
  const manifest = await loadTargetManifest(bucket, record);
  if (manifest.v !== 2) throw new Error("content_not_available");
  const proofs: AuthorizedNode[] = [];
  const sources: { entry: ZipTargetEntry; blob: BlobReadPlan }[] = [];
  for (const entry of manifest.entries) {
    const proof = await authorizeNode(db, principal, {
      operation: "node.read",
      spaceId: entry.spaceId,
      nodeId: entry.nodeId,
    });
    if (
      proof.operation !== "node.read" ||
      proof.node.kind !== "file" ||
      proof.node.owner_id !== record.ownerId ||
      proof.node.current_blob_id !== entry.blobId
    )
      throw new Error("content_not_available");
    const blob = await prepareAuthorizedNodeBlobRead(db, proof);
    if (blob.size !== entry.size || blob.r2Etag !== entry.r2Etag)
      throw new Error("content_not_available");
    const object = await bucket.head(blob.key);
    if (!object || object.size !== entry.size || object.etag !== entry.r2Etag)
      throw new Error("blob_storage_mismatch");
    proofs.push(proof);
    sources.push({ entry, blob });
  }
  const outputSize = storeZipSize(
    sources.map(({ entry }) => ({
      name: entry.path,
      size: entry.size,
      open: async () => {
        throw new Error("zip_measure_open");
      },
    })),
  );
  if (outputSize !== manifest.outputSize) throw new Error("content_not_available");
  const coverageShare =
    record.shareId && record.shareVersion
      ? { id: record.shareId, version: record.shareVersion }
      : undefined;
  const sessionShare = principal.kind === "link_share" ? undefined : coverageShare;
  await atomicBatch(db, [
    contentSessionAssertion(principal, sessionId, record.ticketId, "zip", sessionShare),
    ...authorizationBatchAssertions(proofs),
    ...(coverageShare
      ? shareCoverageBatchAssertions(
          proofs.map((proof) => {
            if (proof.operation !== "node.read") throw new Error("content_not_available");
            return proof.node;
          }),
          coverageShare,
        )
      : []),
    ...zipPathBatchAssertions(manifest.entries, record.ownerId),
    assertExists(
      `SELECT 1 FROM target_sets ts JOIN content_sessions cs ON cs.target_set_id=ts.id
        JOIN tickets t ON t.id=cs.ticket_id AND t.target_set_id=ts.id
        WHERE cs.id=? AND t.id=? AND t.purpose='zip' AND ts.id=? AND ts.owner_id=?
          AND ts.manifest_ref=? AND ts.manifest_hash=? AND ts.total_bytes=? AND cs.budget_id=?`,
      [
        sessionId,
        record.ticketId,
        targetSetId,
        record.ownerId,
        record.ref,
        record.hash,
        record.totalBytes,
        record.budgetId,
      ],
    ),
  ]);
  return Object.freeze({
    budgetId: record.budgetId,
    sessionId,
    epoch: record.epoch,
    outputSize,
    manifestHash: record.hash,
    targetSetId,
    ticketId: record.ticketId,
    principal,
    share: sessionShare,
    sources: Object.freeze(sources),
  });
}

function zipHeaders(plan: ZipContentPlan): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": "attachment; filename*=UTF-8''download.zip",
    "Content-Length": String(plan.outputSize),
    "Content-Type": "application/zip",
    ETag: `"${plan.manifestHash}"`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function watchZipAuthority(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  assertCurrent: () => Promise<unknown>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const dispose = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };
  const stop = async (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    dispose();
    await reader.cancel(reason).catch(() => undefined);
    try {
      output?.error(reason);
    } catch {}
  };
  const poll = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await assertCurrent();
        poll();
      } catch (error) {
        await stop(error);
      }
    }, AUTHORITY_POLL_MS);
  };
  const onAbort = () => void stop(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else poll();
      },
      async pull(controller) {
        if (stopped) return;
        try {
          const next = await reader.read();
          if (stopped) return;
          if (next.done) {
            stopped = true;
            dispose();
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          await stop(error);
        }
      },
      cancel(reason) {
        return stop(reason ?? new DOMException("Cancelled", "AbortError"));
      },
    },
    { highWaterMark: 0 },
  );
}

/** Verify a ZIP session and immutable plan before reserving and opening any source body. */
export async function streamBudgetedZip(
  db: D1Database,
  bucket: R2Bucket,
  budgets: DurableObjectNamespace<BudgetDO>,
  tokens: ContentTokens,
  cookieHeader: string | null,
  targetSetId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") throw new Error("invalid_zip_read");
  request.signal.throwIfAborted();
  const plan = await prepareZipContent(db, bucket, tokens, cookieHeader, targetSetId);
  const bytes = request.method === "GET" ? plan.outputSize : 0;
  const budget = budgets.get(budgets.idFromName(plan.budgetId));
  const requestId = crypto.randomUUID();
  const lease = await budget.reserve({
    budgetId: plan.budgetId,
    sessionId: plan.sessionId,
    requestId,
    epoch: plan.epoch,
    bytes,
  });
  return streamLeasedContent(
    async (signal, deadline) => {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("content_lease_expired");
      const headers = zipHeaders(plan);
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      const archive = storeZip(
        plan.sources.map(({ entry, blob }) => ({
          name: entry.path,
          size: entry.size,
          open: async () => {
            signal.throwIfAborted();
            if (Date.now() >= deadline) throw new Error("content_lease_expired");
            const object = await bucket.get(blob.key);
            if (!object || object.size !== entry.size || object.etag !== entry.r2Etag) {
              void object?.body.cancel().catch(() => undefined);
              throw new Error("blob_storage_mismatch");
            }
            if (signal.aborted) {
              void object.body.cancel(signal.reason).catch(() => undefined);
              signal.throwIfAborted();
            }
            return object.body;
          },
        })),
      );
      if (archive.size !== plan.outputSize) {
        void archive.body.cancel().catch(() => undefined);
        throw new Error("zip_dry_run_mismatch");
      }
      const guarded = watchZipAuthority(archive.body, signal, () =>
        atomicBatch(db, [
          contentSessionAssertion(plan.principal, plan.sessionId, plan.ticketId, "zip", plan.share),
          assertExists(
            "SELECT 1 FROM target_sets WHERE id=? AND manifest_hash=? AND total_bytes=?",
            [plan.targetSetId, plan.manifestHash, plan.outputSize],
          ),
        ]),
      );
      return new Response(guarded, { status: 200, headers });
    },
    bytes,
    lease.expiresAt,
    request.signal,
    (deliveredBytes) => budget.settle({ budgetId: plan.budgetId, requestId, deliveredBytes }),
  );
}
