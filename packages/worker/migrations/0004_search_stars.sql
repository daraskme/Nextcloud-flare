CREATE TABLE node_stars(
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id)
) STRICT;
CREATE INDEX node_stars_node ON node_stars(node_id);
WITH RECURSIVE source(node_id,space_id,text_norm,revision) AS (
  SELECT id,space_id,lower(name),revision FROM nodes WHERE kind<>'root' AND deleted_at IS NULL
), grams(node_id,position,token) AS (
  SELECT node_id,1,substr(text_norm,1,2) FROM source WHERE length(text_norm)>=2
  UNION ALL
  SELECT grams.node_id,grams.position+1,substr(source.text_norm,grams.position+1,2)
  FROM grams JOIN source ON source.node_id=grams.node_id
  WHERE grams.position<length(source.text_norm)-1
), tokens(node_id,value) AS (
  SELECT node_id,group_concat(token,' ') FROM grams GROUP BY node_id
)
INSERT OR IGNORE INTO search_index(node_id,space_id,text_norm,tokens,revision)
SELECT source.node_id,source.space_id,source.text_norm,COALESCE(tokens.value,''),source.revision
FROM source LEFT JOIN tokens ON tokens.node_id=source.node_id;
INSERT INTO search_fts(search_fts) VALUES('rebuild');
