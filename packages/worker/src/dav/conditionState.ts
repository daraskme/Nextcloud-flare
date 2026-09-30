import type { Principal } from "../auth/authorize";
import { lockTokenHashes } from "../auth/locks";
import { atomicBatch } from "../db/primary";
import { type DavResourceState, evaluateDavIf, parseDavIfHeader } from "./conditions";
import { davEtag } from "./etag";
import { parseDavPath, resolveDavConditionPath } from "./path";

interface StateRow {
  id: string;
  kind: "root" | "folder" | "file";
  revision: number;
  current_blob_id: string | null;
}
interface LockRow {
  token_hash: string;
}

async function resourceState(
  db: D1Database,
  principal: Principal,
  appOrigin: string,
  resource: string,
  tokenByHash: ReadonlyMap<string, string>,
): Promise<DavResourceState> {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return { tokens: new Set(), etag: null };
  }
  if (
    url.origin !== appOrigin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return { tokens: new Set(), etag: null };
  let path;
  try {
    path = parseDavPath(url.pathname);
  } catch {
    return { tokens: new Set(), etag: null };
  }
  const resolved = await resolveDavConditionPath(db, principal, path);
  if (!resolved) return { tokens: new Set(), etag: null };
  const batches = await atomicBatch(db, [
    resolved.assertion,
    {
      sql: `SELECT id,kind,revision,current_blob_id FROM nodes
          WHERE id=? AND space_id=? AND deleted_at IS NULL`,
      values: [resolved.id, resolved.spaceId],
    },
    {
      sql: `WITH RECURSIVE a(id,parent_id,depth) AS (
          SELECT id,parent_id,0 FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
          UNION ALL
          SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN a ON n.id=a.parent_id
            WHERE a.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
        ) SELECT DISTINCT l.token_hash FROM a JOIN locks l ON l.node_id=a.id
          WHERE l.space_id=? AND l.epoch=? AND l.expires_at>strftime('%s','now')*1000
            AND (a.depth=0 OR l.depth='infinity')`,
      values: [resolved.id, resolved.spaceId, resolved.spaceId, resolved.spaceId, principal.epoch],
    },
  ]);
  const node = batches[1]?.results[0] as StateRow | undefined;
  if (!node) return { tokens: new Set(), etag: null };
  const tokens = new Set<string>();
  for (const row of (batches[2]?.results ?? []) as LockRow[]) {
    const token = tokenByHash.get(row.token_hash);
    if (token) tokens.add(token);
  }
  return { tokens, etag: davEtag(node) };
}

/** Parse and evaluate If against bounded current DAV state, returning submitted lock tokens. */
export async function evaluateDavRequestIf(
  db: D1Database,
  principal: Principal,
  appOrigin: string,
  request: Request,
): Promise<readonly string[]> {
  const header = parseDavIfHeader(request.headers.get("If"));
  if (!header) return [];
  if (header.submittedTokens.length > 16) throw new Error("invalid_dav_if");
  const tokenByHash = new Map(
    await Promise.all(
      header.submittedTokens.map(
        async (token) => [(await lockTokenHashes([token]))[0]!, token] as const,
      ),
    ),
  );
  const requestUrl = new URL(request.url);
  requestUrl.search = "";
  requestUrl.hash = "";
  const matches = await evaluateDavIf(header, requestUrl.href, (resource) =>
    resourceState(db, principal, appOrigin, resource, tokenByHash),
  );
  if (!matches) throw new Error("dav_precondition_failed");
  return header.submittedTokens;
}
