import type { Env } from "../env.js";
import { normalizeSearchText, searchTokens } from "./normalize.js";

export function deleteSearchStatements(env: Env, nodeId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?1",
    ).bind(nodeId),
    env.DB.prepare("DELETE FROM search_index WHERE node_id=?1").bind(nodeId),
  ];
}

export function upsertSearchStatements(
  env: Env,
  input: { nodeId: string; spaceId: string; text: string; revision: number },
): D1PreparedStatement[] {
  const text = normalizeSearchText(input.text);
  return [
    ...deleteSearchStatements(env, input.nodeId),
    env.DB.prepare(
      "INSERT INTO search_index(node_id,space_id,text_norm,tokens,revision) VALUES(?1,?2,?3,?4,?5)",
    ).bind(input.nodeId, input.spaceId, text, searchTokens(text), input.revision),
    env.DB.prepare(
      "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?1",
    ).bind(input.nodeId),
  ];
}
