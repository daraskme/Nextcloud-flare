import type { Env } from "../env.js";

const tables = [
  { table: "media_jobs", kind: "media-extract" },
  { table: "library_jobs", kind: "library-index" },
  { table: "audio_jobs", kind: "audio-extract" },
] as const;

export async function dispatchNodeJobs(env: Env, nodeId: string): Promise<void> {
  if (env.ENVIRONMENT === "test") return;
  for (const { table, kind } of tables) {
    if (env.ENVIRONMENT === "development" && kind === "media-extract") continue;
    const rows = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE node_id=?1 AND state='pending' ORDER BY created_at,id LIMIT 8`,
    )
      .bind(nodeId)
      .all<{ id: string }>();
    for (const row of rows.results) {
      await env.JOBS.send({ kind, jobId: row.id }).catch(() => undefined);
    }
  }
}
