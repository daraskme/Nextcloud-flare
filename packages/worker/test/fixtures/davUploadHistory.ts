import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { davUploadRow } from "../../src/services/davUpload";
import { davPutFixture } from "./davPut";

/** Persisted history with real past timestamps; never disable immutable expiry/identity triggers. */
export async function davUploadHistory(
  options: {
    state?: "receiving" | "completing";
    expired?: boolean;
    present?: boolean;
    epoch?: number;
    operationState?: "claimed" | "failed" | "committed";
  } = {},
) {
  const f = await davPutFixture(),
    op = "op_" + crypto.randomUUID(),
    id = "dav_" + op,
    blob = op + "_blob",
    reservation = op + "_reservation";
  const state = options.state ?? "receiving",
    created = Date.now() - (options.expired === false ? 1000 : 25 * 3600000),
    expires = created + 86400000,
    epoch = options.epoch ?? 1,
    attempt = crypto.randomUUID(),
    key = `u/${f.ids.user}/b/${blob}`;
  const metadata = { upload_id: id, blob_id: blob, attempt_id: attempt, epoch: String(epoch) };
  const object = options.present
    ? await env.BLOBS.put(key, "abc", { customMetadata: metadata })
    : null;
  const stored = state === "completing";
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,?,1,'released')",
      values: [op, f.ids.space, epoch],
    },
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
      permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,created_at,updated_at)
      VALUES(?,'app_password',?,?,?,'dav.put',?,'history',?,?,1,1,10,?,?,?)`,
      values: [
        op,
        f.ids.user,
        f.input.principal.credential_id,
        f.ids.space,
        options.operationState ?? (stored ? "failed" : "claimed"),
        epoch,
        op,
        JSON.stringify({ parentId: f.ids.folder }),
        created,
        created,
      ],
    },
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,op_id) VALUES(?,?,3,'reserved',?,?,?)",
      values: [reservation, f.ids.user, expires, epoch, op],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,content_etag,r2_etag,state,created_at) VALUES(?,?,?,3,?,'content',?,'staging',?)",
      values: [
        blob,
        f.ids.user,
        key,
        stored ? "a".repeat(64) : null,
        stored ? (object?.etag ?? "missing") : null,
        created,
      ],
    },
    ...(stored && object
      ? [
          {
            sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
            values: [blob, object.etag, created],
          },
        ]
      : []),
    {
      sql: `INSERT INTO uploads(id,source,owner_id,space_id,parent_id,blob_id,reservation_id,credential_id,mode,state,declared_size,
      capability_hash,epoch,accept_parts,in_flight,created_at,expires_at,last_progress_at,upload_name,request_digest,
      write_attempt_id,write_lease_expires_at,completion_op_id)
      VALUES(?,'dav',?,?,?,?,?,?,'single',?,3,'internal:dav',?,0,?,?,?,?, 'history.txt','history',?,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        reservation,
        f.input.principal.credential_id,
        state,
        epoch,
        stored ? 0 : 1,
        created,
        expires,
        created,
        attempt,
        created + 900000,
        op,
      ],
    },
  ]);
  return {
    ...f,
    id,
    blob,
    reservation,
    operationId: op,
    key,
    metadata,
    object,
    row: (await davUploadRow(env.DB, op))!,
  };
}
