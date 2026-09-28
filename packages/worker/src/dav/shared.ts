import type { Principal } from "../auth/authorize";
import { assertExists, atomicBatch } from "../db/primary";
import { type DavPath, sharedDavCredentialQuery } from "./path";
import {
  davMultistatus,
  davNodeResponseXml,
  type LockRow,
  type NodeRow,
  type PropRow,
  SHARED_COLLECTION,
} from "./propfind";
import type { PropfindRequest } from "./xml";

const MAX_MOUNTS = 1_000;
// Candidate work is bounded before ancestry traversal, including malformed legacy trees.
const CATALOG = `WITH RECURSIVE candidates AS (
  SELECT sh.id AS share_id,sh.mount_name,n.* FROM shares sh
  JOIN share_grants g ON g.share_id=sh.id AND g.user_id=?1 AND g.version=sh.version AND g.disabled_at IS NULL
  JOIN users u ON u.id=sh.owner_id AND u.disabled_at IS NULL
  JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
  WHERE sh.kind='internal' AND sh.disabled_at IS NULL AND sh.mount_name IS NOT NULL
    AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
    AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action='read')
  ORDER BY sh.mount_name_ci,sh.id LIMIT ${MAX_MOUNTS + 1}
), ancestors(share_id,id,parent_id,space_id,owner_id,kind,deleted_at,depth,visited) AS (
  SELECT share_id,id,parent_id,space_id,owner_id,kind,deleted_at,0,'/'||id||'/' FROM candidates
  UNION ALL SELECT a.share_id,n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.visited||n.id||'/'
    FROM ancestors a JOIN nodes n ON n.id=a.parent_id AND n.space_id=a.space_id AND n.owner_id=a.owner_id
    WHERE a.depth<64 AND instr(a.visited,'/'||n.id||'/')=0
), visible AS (
  SELECT c.* FROM candidates c WHERE EXISTS(SELECT COUNT(*) FROM ancestors a
    JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=a.owner_id WHERE a.share_id=c.share_id
    HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
      AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1)
)`;

export async function sharedDavAvailable(db: D1Database, principal: Principal, readScope = false) {
  const q = sharedDavCredentialQuery(principal, readScope);
  return !!(await db
    .prepare(q.sql)
    .bind(...q.values)
    .first());
}

/** List live fixed mounts without exposing the owner's ancestors or historical NULL mounts. */
export async function sharedPropfindResponse(
  db: D1Database,
  principal: Principal,
  path: DavPath,
  depth: 0 | 1,
  request: PropfindRequest,
): Promise<Response> {
  const credential = sharedDavCredentialQuery(principal);
  if (principal.kind !== "app_password") throw new Error("dav_node_unavailable");
  const values = [principal.user_id];
  const batches = await atomicBatch(db, [
    assertExists(credential.sql, credential.values),
    ...(depth === 0
      ? []
      : [
          { sql: `${CATALOG} SELECT COUNT(*) AS count FROM candidates`, values },
          {
            sql: `${CATALOG} SELECT v.share_id AS shareId,v.id,v.name,v.mount_name AS hrefName,v.kind,v.revision,
        v.current_blob_id AS currentBlobId,b.size,v.created_at AS createdAt,v.updated_at AS updatedAt
        FROM visible v LEFT JOIN blobs b ON b.id=v.current_blob_id AND b.owner_id=v.owner_id ORDER BY v.mount_name,v.share_id`,
            values,
          },
          {
            sql: `${CATALOG} SELECT v.share_id AS shareId,p.node_id AS nodeId,p.namespace,p.name,p.value_xml AS valueXml
        FROM visible v JOIN node_props p ON p.node_id=v.id`,
            values,
          },
          {
            sql: `${CATALOG} SELECT v.share_id AS shareId,v.id AS nodeId,l.id,l.depth,
        CASE WHEN a.depth=0 THEN l.owner_text ELSE '' END AS ownerText,
        CAST((l.expires_at-strftime('%s','now')*1000+999)/1000 AS INTEGER) AS timeoutSeconds
        FROM visible v JOIN ancestors a ON a.share_id=v.share_id JOIN locks l
          ON l.node_id=a.id AND l.space_id=v.space_id AND (a.depth=0 OR l.depth='infinity')
        WHERE l.epoch=?2 AND l.expires_at>strftime('%s','now')*1000`,
            values: [...values, principal.epoch],
          },
        ]),
  ]);
  if (Number((batches[1]?.results[0] as { count: number } | undefined)?.count ?? 0) > MAX_MOUNTS)
    throw new Error("dav_children_limit");
  const nodes = (batches[2]?.results ?? []) as (NodeRow & { shareId: string })[];
  const props = (batches[3]?.results ?? []) as (PropRow & { shareId: string })[];
  const locks = (batches[4]?.results ?? []) as (LockRow & { shareId: string })[];
  return davMultistatus([
    davNodeResponseXml(path, SHARED_COLLECTION, false, request, [], []),
    ...nodes.map((node) => {
      const nodeLocks = locks
        .filter((l) => l.shareId === node.shareId)
        .map((l) => ({
          ...l,
          displayHref: `/dav/Shared/${encodeURIComponent(node.hrefName!)}${node.kind === "file" ? "" : "/"}`,
        }));
      const nodeProps = props.filter((p) => p.shareId === node.shareId);
      if (nodeLocks.length > 1 || nodeProps.length > 100) throw new Error("dav_data_invalid");
      return davNodeResponseXml(path, node, true, request, nodeProps, nodeLocks);
    }),
  ]);
}
