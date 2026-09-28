import type { InternalShare } from "../../../shared/src/shares";
import type { ListCursorClaims, ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import { atomicBatch, type BindValue } from "../db/primary";
import { shareAccess } from "./internalShares";

const CLOCK = "strftime('%s','now')*1000";
interface Row {
  id: string;
  createdAt: number;
  visible: number;
  data: string;
}

/** One hundred roots plus a lookahead, with bounded ancestors from one D1 snapshot. */
export async function sharePage(
  db: D1Database,
  session: AccessSession,
  received: boolean,
  root: string | undefined,
  after: ListCursorClaims | null,
  limit: number,
  id?: string,
  kind: "internal" | "link" | "upload_only" = "internal",
) {
  const values: BindValue[] = [session.user_id, ...(received ? [session.user_id] : [])];
  let filter = received
    ? `sh.owner_id<>? AND EXISTS(SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=? AND g.disabled_at IS NULL AND g.version=sh.version)`
    : "sh.owner_id=?";
  if (root) {
    filter += " AND sh.root_node_id=?";
    values.push(root);
  }
  if (id) {
    filter += " AND sh.id=?";
    values.push(id);
  }
  if (after) {
    filter += " AND (sh.created_at,sh.id)<(?,?)";
    values.push(after.lastSort, after.lastId);
  }
  values.push(limit + 1, session.user_id);
  const result = await atomicBatch(db, [
    ...shareAccess(session),
    {
      sql: `WITH RECURSIVE candidates AS (
      SELECT sh.*,n.space_id FROM shares sh JOIN nodes n ON n.id=sh.root_node_id AND n.owner_id=sh.owner_id
      JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
      WHERE sh.kind='${kind}' AND sh.disabled_at IS NULL
      ${received ? `AND (sh.expires_at IS NULL OR sh.expires_at>${CLOCK})` : ""}
      AND ${
        kind === "upload_only"
          ? "n.kind IN ('root','folder') AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='create') AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='upload')"
          : "EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')"
      }
      AND ${filter} ORDER BY sh.created_at DESC,sh.id DESC LIMIT ?
    ), a(share_id,id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
      SELECT c.id,n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,0,'/'||n.id||'/'
      FROM candidates c JOIN nodes n ON n.id=c.root_node_id
      UNION ALL SELECT a.share_id,n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.path||n.id||'/'
      FROM a JOIN nodes n ON n.id=a.parent_id AND n.space_id=a.space_id AND n.owner_id=a.owner_id
      WHERE a.depth<64 AND instr(a.path,'/'||n.id||'/')=0
    ) SELECT c.id,c.created_at AS createdAt,
      EXISTS(SELECT COUNT(*) FROM a JOIN spaces sp ON sp.id=a.space_id AND sp.owner_id=a.owner_id
        WHERE a.share_id=c.id HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(a.deleted_at IS NULL)=1
        AND SUM(a.kind='root' AND a.parent_id IS NULL AND a.id=sp.root_node_id)=1) AS visible,
      json_object('id',c.id,'kind',c.kind,'rootNodeId',n.id,'spaceId',n.space_id,'ownerId',c.owner_id,
        'name',n.name,'nodeKind',n.kind,'version',c.version,'createdAt',c.created_at,'expiresAt',c.expires_at,
        ${
          kind === "upload_only"
            ? "'reservationLimit',c.reservation_limit,'reservedBytes',c.reserved_bytes,"
            : "'role',CASE WHEN EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=c.id AND sa.action='edit') THEN 'edit' ELSE 'read' END,"
        }
        ${
          kind !== "internal"
            ? "'hasPassword',json(CASE WHEN c.owner_id=? AND c.password_digest IS NOT NULL THEN 'true' ELSE 'false' END)"
            : `'mountName',c.mount_name,'recipients',json(CASE WHEN c.owner_id=? THEN (SELECT json_group_array(json_object('userId',u.id,'email',u.email))
          FROM share_grants g JOIN users u ON u.id=g.user_id WHERE g.share_id=c.id AND g.disabled_at IS NULL AND g.version=c.version)
          ELSE '[]' END)`
        }) AS data
      FROM candidates c JOIN nodes n ON n.id=c.root_node_id ORDER BY c.created_at DESC,c.id DESC`,
      values,
    },
  ]);
  return (result.at(-1)?.results ?? []) as Row[];
}
export async function readInternalShare(
  db: D1Database,
  session: AccessSession,
  id: string,
  allowRecipient = false,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("share_unavailable");
  let row = (await sharePage(db, session, false, undefined, null, 1, id))[0];
  if (!row && allowRecipient) row = (await sharePage(db, session, true, undefined, null, 1, id))[0];
  if (!row || row.visible !== 1) throw new Error("share_unavailable");
  return JSON.parse(row.data) as InternalShare;
}
export async function listInternalShares(
  db: D1Database,
  session: AccessSession,
  tokens: ListCursorTokens,
  options: { received?: boolean; rootNodeId?: string; cursor?: string; limit?: number } = {},
) {
  const { received = false, rootNodeId: root, cursor, limit = 100 } = options;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (root !== undefined && (!/^[A-Za-z0-9_-]{1,128}$/.test(root) || received))
  )
    throw new Error("invalid_share_request");
  const aud = received ? "share-received" : root ? "share-root" : "share-owned",
    scopeId = root ?? session.user_id;
  const after = cursor ? await tokens.verify(cursor) : null;
  if (
    after &&
    (after.aud !== aud ||
      after.scopeId !== scopeId ||
      after.userId !== session.user_id ||
      after.credentialId !== session.credential_id ||
      after.epoch !== session.epoch ||
      after.generation !== 1)
  )
    throw new Error("invalid_list_cursor");
  const rows = await sharePage(db, session, received, root, after, limit),
    examined = rows.slice(0, limit),
    last = examined.at(-1);
  return {
    items: examined
      .filter((row) => row.visible === 1)
      .map((row) => JSON.parse(row.data) as InternalShare),
    nextCursor:
      rows.length > limit && last
        ? await tokens.issue({
            aud,
            scopeId,
            userId: session.user_id,
            credentialId: session.credential_id,
            epoch: session.epoch,
            generation: 1,
            lastSort: last.createdAt,
            lastId: last.id,
          })
        : null,
  };
}
