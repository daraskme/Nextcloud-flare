import { atomicBatch } from "../../src/db/primary";

/** Isolated browser fixture only: aliases three real uploaded/parsed Opus originals. */
export async function audioLibraryFixture(db: D1Database, input: unknown) {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    new Set(input).size !== 3 ||
    !input.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("invalid_audio_fixture");
  const sources = await db
    .prepare(`SELECT n.id,n.owner_id,n.space_id,n.current_blob_id,s.root_node_id
    FROM nodes n JOIN spaces s ON s.id=n.space_id JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id
    JOIN blobs b ON b.id=n.current_blob_id
    WHERE n.id IN (?,?,?) AND n.hidden=0 AND n.deleted_at IS NULL AND a.codec='opus'
      AND a.generator_version='track-metadata-v1' AND a.duration_ms=90000 AND b.state='committed'`)
    .bind(...input)
    .all<{
      id: string;
      owner_id: string;
      space_id: string;
      current_blob_id: string;
      root_node_id: string;
    }>();
  const rows = sources.results;
  if (
    rows.length !== 3 ||
    new Set(rows.map((x) => x.owner_id)).size !== 1 ||
    new Set(rows.map((x) => x.space_id)).size !== 1 ||
    new Set(rows.map((x) => x.current_blob_id)).size !== 3
  )
    throw new Error("invalid_audio_fixture_sources");
  const owner = rows[0]!,
    id = crypto.randomUUID(),
    folder = `${id}-library`;
  await atomicBatch(db, [
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Audio 2001','audio 2001','folder',1,1)",
      values: [folder, owner.space_id, owner.owner_id, owner.root_node_id],
    },
    {
      sql: `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<2000)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
      SELECT ?1||'-'||i,?2,?3,?4,printf('%06d.opus',i),printf('%06d.opus',i),'file',
        CASE i%3 WHEN 0 THEN ?5 WHEN 1 THEN ?6 ELSE ?7 END,1,1 FROM seq`,
      values: [id, owner.space_id, owner.owner_id, folder, ...rows.map((x) => x.current_blob_id)],
    },
    {
      sql: `INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms,title_extracted,artist_extracted,album_extracted)
      SELECT n.id,n.current_blob_id,'track-metadata-v1','opus',90000,substr(n.name,1,6)||' '||?1,?2,?3
      FROM nodes n WHERE n.parent_id=?4`,
      values: ["曲".repeat(339), "演".repeat(341), "奏".repeat(341), folder],
    },
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?",
      values: [owner.space_id],
    },
  ]);
  return { folderId: folder, firstId: `${id}-0`, lastId: `${id}-1999`, count: 2001 };
}
