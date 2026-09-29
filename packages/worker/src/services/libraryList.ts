import type { LibraryItem, LibraryPage } from "../../../shared/src/library";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { LibraryCursorTokens } from "../auth/libraryCursor";
import { atomicBatch, primary } from "../db/primary";
import { ARCHIVE_GENERATOR } from "../media/archive/codec";
import { ARCHIVE_BOOK_SOURCE } from "./archiveRead";
import { readingState } from "./libraryBook";

export const LIBRARY_CANDIDATE_LIMIT = 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export async function libraryAuthority(db: D1Database, principal: Principal, rootId: string) {
  if (!ID.test(rootId) || !["user", "link_share"].includes(principal.kind))
    throw new Error("authorization_denied");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(rootId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("authorization_denied");
  const proof = await authorizeNode(db, principal, {
    operation: "library.read",
    nodeId: rootId,
    spaceId,
  });
  if (
    proof.operation !== "library.read" ||
    (principal.kind === "user" &&
      proof.node.owner_id !== principal.user_id &&
      !principal.selected_share)
  )
    throw new Error("authorization_denied");
  return proof;
}

/** Bound the visible window before format filters and metadata/output joins. */
export function libraryStatement(file: boolean, after: boolean) {
  const suffix = "lower(candidate.name)",
    format = `CASE WHEN candidate.kind IN ('root','folder') THEN 'folder' WHEN ${suffix} LIKE '%.cbz' THEN 'cbz'
      WHEN ${suffix} LIKE '%.zip' THEN 'zip' WHEN ${suffix} LIKE '%.epub' THEN 'epub' WHEN ${suffix} LIKE '%.pdf' THEN 'pdf'
      WHEN ${suffix} LIKE '%.cbr' THEN 'cbr' WHEN ${suffix} LIKE '%.rar' THEN 'rar' WHEN ${suffix} LIKE '%.7z' THEN '7z' END`;
  return `WITH candidates AS MATERIALIZED (
    SELECT id,name,name_ci,current_blob_id,owner_id,kind,revision,updated_at FROM nodes ${file ? "" : "INDEXED BY nodes_audio_candidates"}
    WHERE ${file ? "id=?1" : "parent_id=?1"} AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL AND hidden=0
      AND ${after ? "(name_ci,id)>(?5,?6)" : "?5 IS NULL AND ?6 IS NULL"}
    ORDER BY name_ci,id LIMIT ${file ? 1 : LIBRARY_CANDIDATE_LIMIT + 1}
  ), scanned AS MATERIALIZED (SELECT * FROM candidates ORDER BY name_ci,id LIMIT ${LIBRARY_CANDIDATE_LIMIT}),
  page AS MATERIALIZED (
    SELECT candidate.id,candidate.name,candidate.name_ci AS nameCi,candidate.kind,candidate.revision,candidate.updated_at AS updatedAt,candidate.current_blob_id AS currentBlobId,
      b.size,b.mime_sniffed AS mime,${format} AS format,
      COALESCE(l.title_override,l.title_extracted,candidate.name) AS title,
      COALESCE(l.author_override,l.author_extracted) AS author,COALESCE(l.series_override,l.series_extracted) AS series,
      l.page_count AS pageCount,ai.sha256 AS indexHash,d.state AS indexState,d.error_code AS indexError,
      EXISTS(SELECT 1 ${ARCHIVE_BOOK_SOURCE} AND (n.id=candidate.id AND n.space_id=?2 AND n.owner_id=?3)) AS ready,
      p.position_json AS position,p.updated_at AS stateUpdatedAt
    FROM scanned candidate LEFT JOIN blobs b ON b.id=candidate.current_blob_id AND b.owner_id=candidate.owner_id AND b.state IN ('committed','gc_candidate')
    LEFT JOIN library_items l ON l.node_id=candidate.id AND l.blob_id=candidate.current_blob_id AND l.generator_version='${ARCHIVE_GENERATOR}'
    LEFT JOIN archive_index ai ON ai.node_id=candidate.id AND ai.blob_id=candidate.current_blob_id AND ai.generator_version='${ARCHIVE_GENERATOR}'
    LEFT JOIN derivative_results d ON d.blob_id=candidate.current_blob_id AND d.kind='archive_index' AND d.variant='index' AND d.generator_version='${ARCHIVE_GENERATOR}'
    LEFT JOIN user_reading_state p ON p.user_id=?4 AND p.node_id=candidate.id AND p.blob_id=candidate.current_blob_id
    WHERE (${format}) IS NOT NULL AND (candidate.kind IN ('folder','root') OR b.id IS NOT NULL)
    ORDER BY candidate.name_ci,candidate.id LIMIT 201
  ) SELECT (SELECT COUNT(*) FROM scanned) AS scanned,
    (SELECT COUNT(*) FROM candidates)>${LIBRARY_CANDIDATE_LIMIT} AS moreCandidates,
    (SELECT name_ci FROM scanned ORDER BY name_ci DESC,id DESC LIMIT 1) AS lastNameCi,
    (SELECT id FROM scanned ORDER BY name_ci DESC,id DESC LIMIT 1) AS lastId,
    (SELECT json_group_array(json_object('id',p.id,'name',p.name,'nameCi',p.nameCi,'kind',p.kind,'revision',p.revision,
      'updatedAt',p.updatedAt,'currentBlobId',p.currentBlobId,'size',p.size,'mime',p.mime,'format',p.format,'title',p.title,
      'author',p.author,'series',p.series,'pageCount',p.pageCount,'indexHash',p.indexHash,'indexState',p.indexState,'indexError',p.indexError,
      'ready',p.ready,'position',p.position,'stateUpdatedAt',p.stateUpdatedAt)) FROM (SELECT * FROM page ORDER BY nameCi,id) p) AS items`;
}
interface Row extends Omit<LibraryItem, "state" | "reading"> {
  nameCi: string;
  indexHash: string | null;
  indexState: string | null;
  indexError: string | null;
  ready: number;
  position: string | null;
  stateUpdatedAt: number | null;
}
export async function listLibrary(
  db: D1Database,
  principal: Principal,
  rootId: string,
  tokens: LibraryCursorTokens,
  cursor?: string,
): Promise<LibraryPage> {
  const proof = await libraryAuthority(db, principal, rootId),
    root = proof.node;
  const selection =
    principal.kind === "link_share"
      ? { id: principal.share_id, version: principal.share_version }
      : principal.kind === "user"
        ? principal.selected_share
        : undefined;
  const userId = principal.kind === "user" ? principal.user_id : null;
  const claims = {
    parentId: rootId,
    spaceId: root.space_id,
    ownerId: root.owner_id,
    userId,
    credentialId: principal.credential_id,
    epoch: principal.epoch,
    generation: root.tree_generation,
    generator: ARCHIVE_GENERATOR,
    ...(selection ? { shareId: selection.id, shareVersion: selection.version } : {}),
  };
  let name: string | null = null,
    id: string | null = null;
  if (cursor !== undefined) {
    const c = await tokens.verify(cursor);
    if (
      root.kind === "file" ||
      Object.entries(claims).some(([key, value]) => c[key as keyof typeof c] !== value) ||
      c.shareId !== selection?.id ||
      c.shareVersion !== selection?.version
    )
      throw new Error("invalid_library_cursor");
    name = c.lastNameCi;
    id = c.lastId;
  }
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    {
      sql: libraryStatement(root.kind === "file", name !== null),
      values: [rootId, root.space_id, root.owner_id, userId, name, id],
    },
  ]);
  const scan = result.at(-1)!.results[0] as unknown as {
    scanned: number;
    moreCandidates: number;
    lastNameCi: string | null;
    lastId: string | null;
    items: string;
  };
  const rows = JSON.parse(scan.items) as Row[],
    page = rows.slice(0, 200),
    moreItems = rows.length > 200;
  const last = moreItems
    ? page.at(-1)
    : scan.lastId
      ? { id: scan.lastId, nameCi: scan.lastNameCi! }
      : undefined;
  return {
    rootId,
    spaceId: root.space_id,
    treeGeneration: root.tree_generation,
    scanned: scan.scanned,
    nextCursor:
      (moreItems || scan.moreCandidates) && last
        ? await tokens.issue({ ...claims, lastNameCi: last.nameCi, lastId: last.id })
        : null,
    items: page.map(
      ({
        nameCi: _,
        indexHash,
        indexState,
        indexError,
        ready,
        position,
        stateUpdatedAt,
        ...item
      }) => {
        const state: LibraryItem["state"] =
          item.kind === "folder"
            ? "folder"
            : ready
              ? "ready"
              : ["cbr", "rar", "7z"].includes(item.format) || indexError?.startsWith("unsupported_")
                ? "unsupported"
                : indexState === "failed"
                  ? "failed"
                  : ["pdf", "epub"].includes(item.format)
                    ? "original"
                    : "pending";
        return {
          ...item,
          state,
          pageCount: ready ? item.pageCount : null,
          reading:
            ready && indexHash && item.pageCount && position !== null && stateUpdatedAt !== null
              ? readingState(
                  { position, updatedAt: stateUpdatedAt },
                  { indexHash, pageCount: item.pageCount },
                )
              : null,
        };
      },
    ),
  };
}
