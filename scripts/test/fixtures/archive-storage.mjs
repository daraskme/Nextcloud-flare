import { randomUUID } from "node:crypto";

/** Populated storage snapshot fixture; native execution and origin proof use workerd tests. */
export function seedArchiveStorage(db, ids) {
  const now = Date.now(),
    archive = randomUUID(),
    token = randomUUID();
  const id = "archive_" + archive;
  const key = `u/${ids.user}/d/${ids.blob}/archive-index-v1/index/${archive}`;
  db.prepare(
    "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,claim_token,claim_expires_at,created_at,updated_at) VALUES('archive-event','committed-history','node.created',?,'sent',1,?,?,?,?)",
  ).run(ids.file, token, now + 30000, now, now);
  const admission = randomUUID();
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until,system,maintenance) VALUES(?,?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000,1,0)",
  ).run(admission, "system:archive.prepare:" + randomUUID(), ids.space);
  db.prepare(
    "UPDATE mutation_admissions SET state='active',granted_at=strftime('%s','now')*1000,expires_at=strftime('%s','now')*1000+30000 WHERE id=?",
  ).run(admission);
  db.prepare(
    "INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,r2_key,size) VALUES(?,?,'archive_index','index','archive-index-v1','running',?,?,1,1,?,13)",
  ).run(id, ids.blob, token, now + 25000, key);
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,physical_only) VALUES(?,?,13,'reserved',?,1,1)",
  ).run(id, ids.user, now + 25000);
  db.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at) VALUES(?,?,?,13,'output','application/json','staging',?)",
  ).run(id, ids.user, key, now);
  db.prepare(
    "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?,?,'job',NULL,?)",
  ).run(id, id, now);
  db.prepare(
    "INSERT INTO archive_derivative_objects(id,owner_id,source_blob_id,output_blob_id,result_id,reservation_id,pin_id,write_attempt_id,outbox_id,claim_token,epoch,source_json,output_json,generator_version,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,'archive-event',?,1,?,?,'archive-index-v1',?,?,'prepared')",
  ).run(
    archive,
    ids.user,
    ids.blob,
    id,
    id,
    id,
    id,
    randomUUID(),
    token,
    JSON.stringify({
      nodeId: ids.file,
      parentId: ids.folder,
      key: `u/${ids.user}/b/${ids.blob}`,
      size: 3,
      etag: "stored",
    }),
    JSON.stringify({ bytes: 13, sha256: "a".repeat(64), entryCount: 1, pageCount: 1 }),
    now,
    now + 25000,
  );
  db.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?").run(admission);
}
