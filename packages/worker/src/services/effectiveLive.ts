import type { Env } from "../env.js";

export async function isEffectiveLive(
  env: Env,
  nodeId: string,
  rootNodeId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,space_id,kind,deleted_at,depth,path) AS (SELECT id,parent_id,space_id,kind,deleted_at,0,'/'||id||'/' FROM nodes WHERE id=?1 UNION ALL SELECT p.id,p.parent_id,p.space_id,p.kind,p.deleted_at,a.depth+1,a.path||p.id||'/' FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.space_id=a.space_id AND instr(a.path,'/'||p.id||'/')=0) SELECT CASE WHEN COUNT(*) BETWEEN 1 AND 65 AND MIN(deleted_at IS NULL)=1 AND SUM(kind='root' AND parent_id IS NULL)=1 AND MAX(CASE WHEN kind='root' THEN id END)=?2 THEN 1 ELSE 0 END effective_live FROM a",
  )
    .bind(nodeId, rootNodeId)
    .first<{ effective_live: number }>();
  return row?.effective_live === 1;
}
