import { assertExists, type SqlStatement } from "../db/primary";

const QUERY = `WITH RECURSIVE a(id,parent_id,depth,path) AS (
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
      WHERE sa.share_id=sh.id AND sa.action='read')`;

interface CoveredNode {
  readonly id: string;
  readonly space_id: string;
  readonly owner_id: string;
}

interface SelectedShare {
  readonly id: string;
  readonly version: number;
}

/** Pins one selected share root to a node in the same D1 batch as authorization. */
export function shareCoverageAssertion(node: CoveredNode, share: SelectedShare): SqlStatement {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(share.id) ||
    !Number.isSafeInteger(share.version) ||
    share.version < 1
  )
    throw new Error("invalid_share_coverage");
  return assertExists(QUERY, [
    node.id,
    node.space_id,
    node.owner_id,
    node.space_id,
    node.owner_id,
    share.id,
    share.version,
    node.owner_id,
  ]);
}

/** Pack selected-share coverage into ≤96 bindings per D1 statement. */
export function shareCoverageBatchAssertions(
  nodes: readonly CoveredNode[],
  share: SelectedShare,
): readonly SqlStatement[] {
  if (nodes.length === 0 || nodes.length > 1_000) throw new Error("invalid_share_coverage");
  const statements: SqlStatement[] = [];
  for (let start = 0; start < nodes.length; start += 12) {
    const group = nodes.slice(start, start + 12);
    const values = group.flatMap((node) => shareCoverageAssertion(node, share).values ?? []);
    statements.push({
      sql: `INSERT INTO _assert(v) SELECT 1 WHERE NOT (${group.map(() => `EXISTS (${QUERY})`).join(" AND ")})`,
      values,
    });
  }
  return statements;
}
