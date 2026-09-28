import type { LinkShare } from "@next-cloud-flare/shared/linkShares";
import type { ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import { sharePage } from "./internalShareRead";

export async function readLinkShare(
  db: D1Database,
  session: AccessSession,
  id: string,
): Promise<LinkShare> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("share_unavailable");
  const row = (await sharePage(db, session, false, undefined, null, 1, id, "link"))[0];
  if (!row || row.visible !== 1) throw new Error("share_unavailable");
  return JSON.parse(row.data) as LinkShare;
}
export async function listLinkShares(
  db: D1Database,
  session: AccessSession,
  tokens: ListCursorTokens,
  options: { rootNodeId?: string; cursor?: string; limit?: number } = {},
) {
  const { rootNodeId: root, cursor, limit = 100 } = options;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (root !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(root))
  )
    throw new Error("invalid_share_request");
  const aud = root ? "link-root" : "link-owned",
    scopeId = root ?? session.user_id,
    after = cursor ? await tokens.verify(cursor) : null;
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
  const rows = await sharePage(db, session, false, root, after, limit, undefined, "link"),
    examined = rows.slice(0, limit),
    last = examined.at(-1);
  return {
    items: examined
      .filter((row) => row.visible === 1)
      .map((row) => JSON.parse(row.data) as LinkShare),
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
