// Same bound statements are executed in native SQLite and Workers D1.
import type { SqlStatement } from "../../src/db/primary";

export function foundationFixture(prefix = "f", now = 1000) {
  const ids = {
    user: `${prefix}-u`,
    space: `${prefix}-s`,
    root: `${prefix}-r`,
    folder: `${prefix}-d`,
    blob: `${prefix}-b`,
    file: `${prefix}-f`,
    session: `${prefix}-session`,
    credential: `as:${prefix}-session`,
  };
  const statements: SqlStatement[] = [
    {
      sql: "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,?,?,?,?,?,?)",
      values: [
        ids.user,
        "https://access.invalid",
        ids.user,
        "fixture@example.invalid",
        "app_admin",
        10000000,
        now,
      ],
    },
    {
      sql: "INSERT INTO spaces(id,owner_id,root_node_id) VALUES(?,?,?)",
      values: [ids.space, ids.user, ids.root],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,'','','root',?,?)",
      values: [ids.root, ids.space, ids.user, now, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Folder','folder','folder',?,?)",
      values: [ids.folder, ids.space, ids.user, ids.root, now, now],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',?)",
      values: [ids.blob, ids.user, `u/${ids.user}/b/${ids.blob}`, `"b-${ids.blob}"`, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'File','file','file',?,?,?)",
      values: [ids.file, ids.space, ids.user, ids.folder, ids.blob, now, now],
    },
    {
      sql: "INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at) VALUES(?,?,'access',?,1,?,?,?)",
      values: [ids.session, ids.user, `${prefix}-fingerprint`, now, now + 600000, now],
    },
    {
      sql: "INSERT INTO credentials(id,kind,session_id) VALUES(?,'access',?)",
      values: [ids.credential, ids.session],
    },
  ];
  return { ids, statements };
}
