/** Indexed successor traversal: one node per recursive step, without queuing all siblings.
 * Bindings: ?1 authorized scope, ?2 space, ?3 owner. Includes the scope itself. */
export const SUBTREE_NODE_LIMIT = 10_000;
export const BOUNDED_SUBTREE_CTE = `WITH RECURSIVE ancestors(id,parent_id,depth) AS (
    SELECT id,parent_id,0 FROM nodes WHERE id=?1
    UNION ALL
    SELECT n.id,n.parent_id,a.depth+1 FROM ancestors a JOIN nodes n ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
      LIMIT 65
  ), walk(id,parent_id,name_ci,kind,depth,entering,visited) AS MATERIALIZED (
    SELECT id,parent_id,name_ci,kind,(SELECT MAX(depth) FROM ancestors),1,1 FROM nodes
      WHERE id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL
    UNION ALL
    SELECT n.id,n.parent_id,n.name_ci,n.kind,
      w.depth+CASE WHEN n.parent_id=w.id THEN 1 WHEN n.id=w.parent_id THEN -1 ELSE 0 END,
      n.id IS NOT w.parent_id,w.visited+(n.id IS NOT w.parent_id)
    FROM walk w JOIN nodes n ON n.id=COALESCE(
      CASE WHEN w.entering=1 AND w.kind IN ('root','folder') AND w.depth<64 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.parent_id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          AND (c.name_ci,c.id)>(w.name_ci,w.id) ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN w.parent_id END)
      WHERE w.visited<${SUBTREE_NODE_LIMIT} AND n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
      LIMIT 20000
  ), scope AS MATERIALIZED (
    SELECT id,kind,depth FROM walk WHERE entering=1 LIMIT ${SUBTREE_NODE_LIMIT}
  )`;
