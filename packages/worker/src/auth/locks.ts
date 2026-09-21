import { assertExists, type SqlStatement } from "../db/primary";
import type { Principal } from "./authorize";

export async function lockTokenHashes(tokens: readonly string[]): Promise<string[]> {
  if (
    !Array.isArray(tokens) ||
    tokens.length > 16 ||
    tokens.some((token) => typeof token !== "string" || token.length < 1 || token.length > 256)
  )
    throw new Error("invalid_lock_tokens");
  const hashes = await Promise.all(
    tokens.map(async (token) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      return Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
    }),
  );
  return [...new Set(hashes)].sort();
}

/** A direct collection lock protects membership changes, even at depth 0. */
export function assertCreateLocks(
  parentId: string,
  spaceId: string,
  principal: Principal,
  tokenHashes: readonly string[],
): SqlStatement {
  const actor =
    principal.kind === "user" || principal.kind === "app_password" ? principal.user_id : null;
  return assertExists(
    `WITH RECURSIVE a(id,parent_id,depth) AS (
      SELECT id,parent_id,0 FROM nodes WHERE id=?1 AND space_id=?2
      UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN a ON n.id=a.parent_id WHERE a.depth<64 AND n.space_id=?2
    ) SELECT 1 WHERE NOT EXISTS(
      SELECT 1 FROM locks l JOIN a ON a.id=l.node_id JOIN credentials c ON c.id=l.creator_credential_id
        LEFT JOIN sessions s ON s.id=c.session_id LEFT JOIN app_passwords ap ON ap.id=c.app_password_id
      WHERE l.space_id=?2 AND l.epoch=?3 AND l.expires_at>strftime('%s','now')*1000
        AND (a.depth=0 OR l.depth='infinity') AND NOT (
          ?4 IS NOT NULL AND COALESCE(s.user_id,ap.user_id,'')=?4 AND l.token_hash IN (SELECT value FROM json_each(?5))))`,
    [parentId, spaceId, principal.epoch, actor, JSON.stringify(tokenHashes)],
  );
}
