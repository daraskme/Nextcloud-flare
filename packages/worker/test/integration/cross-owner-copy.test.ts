import { scopes } from "@ncf/shared";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import { processCrossOwnerCopy, startCrossOwnerCopy } from "../../src/jobs/copy.js";
import { seedFoundation } from "../helpers/foundation.js";

const destinationUser: AuthenticatedUser = {
  email: "destination@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "destination",
    userId: "destination",
    sessionId: "destination-session",
    credentialId: "as:destination-session",
    scopes: [...scopes],
  },
};

beforeEach(async () => {
  const now = Date.now();
  await seedFoundation(now);
  await env.BLOBS.put("u/user/b/source-blob", "copy");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,r2_etag,ref_count,state,created_at) VALUES('source-blob','user','u/user/b/source-blob',4,'\"b-source-blob\"','r2-source',1,'committed',?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('source-file','space','user','root','source.txt','source.txt','file','source-blob',1,?1,?1,0)",
    ).bind(now),
    env.DB.prepare("UPDATE users SET used_bytes=4,physical_bytes=4 WHERE id='user'"),
    env.DB.prepare(
      "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,used_bytes,physical_bytes,reserved_bytes,disabled_at,created_at) VALUES('destination','iss','destination','destination@test.invalid','member',1000000,0,0,0,NULL,?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO spaces(id,owner_id,root_node_id,tree_generation) VALUES('destination-space','destination','destination-root',1)",
    ),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('destination-root','destination-space','destination',NULL,'','', 'root',NULL,1,?1,?1,0)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,issued_at,expires_at,revoked_at,last_seen_at) VALUES('destination-session','destination','access','destination-fingerprint',?1,?2,NULL,?1)",
    ).bind(now, now + 86_400_000),
  ]);
});

describe("cross-owner copy job", () => {
  it("pins the source and atomically publishes destination quota/ref/job terminal state", async () => {
    const jobId = await startCrossOwnerCopy(
      env,
      destinationUser,
      {
        sourceNodeId: "source-file",
        sourceRootId: "root",
        destinationParentId: "destination-root",
        name: "received.txt",
      },
      async () => Promise.resolve(),
    );
    const admitted = await env.DB.prepare(
      "SELECT j.state,b.ref_count,u.reserved_bytes,(SELECT COUNT(*) FROM blob_pins WHERE pin_id=j.pin_id) pins FROM bulk_jobs j JOIN blobs b ON b.id=j.source_blob_id JOIN users u ON u.id=j.destination_owner_id WHERE j.id=?1",
    )
      .bind(jobId)
      .first();
    expect(admitted).toEqual({ state: "pending", ref_count: 2, reserved_bytes: 4, pins: 1 });

    await processCrossOwnerCopy(env, jobId);
    const completed = await env.DB.prepare(
      "SELECT j.state,j.attempt,j.r2_calls,j.bytes_processed,b.ref_count,u.used_bytes,u.reserved_bytes,(SELECT COUNT(*) FROM blob_pins WHERE pin_id=j.pin_id) pins FROM bulk_jobs j JOIN blobs b ON b.id=j.source_blob_id JOIN users u ON u.id=j.destination_owner_id WHERE j.id=?1",
    )
      .bind(jobId)
      .first();
    expect(completed).toEqual({
      state: "completed",
      attempt: 1,
      r2_calls: 1,
      bytes_processed: 4,
      ref_count: 1,
      used_bytes: 4,
      reserved_bytes: 0,
      pins: 0,
    });
    const node = await env.DB.prepare(
      "SELECT n.name,n.owner_id,b.r2_key,b.ref_count,b.state FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id='destination-root'",
    ).first();
    expect(node).toMatchObject({
      name: "received.txt",
      owner_id: "destination",
      ref_count: 1,
      state: "committed",
    });
    expect((node as { r2_key: string }).r2_key).toMatch(/^u\/destination\/b\//u);
  });

  it("terminates after three fenced attempts and releases admission ledgers", async () => {
    const jobId = await startCrossOwnerCopy(
      env,
      destinationUser,
      {
        sourceNodeId: "source-file",
        sourceRootId: "root",
        destinationParentId: "destination-root",
      },
      async () => Promise.resolve(),
    );
    await env.DB.prepare(
      "UPDATE bulk_jobs SET state='claimed',attempt=3,claim_token='expired',claim_expires_at=0 WHERE id=?1",
    )
      .bind(jobId)
      .run();
    await processCrossOwnerCopy(env, jobId);
    const terminal = await env.DB.prepare(
      "SELECT j.state,j.last_error,b.ref_count,u.reserved_bytes,(SELECT COUNT(*) FROM blob_pins WHERE pin_id=j.pin_id) pins FROM bulk_jobs j JOIN blobs b ON b.id=j.source_blob_id JOIN users u ON u.id=j.destination_owner_id WHERE j.id=?1",
    )
      .bind(jobId)
      .first();
    expect(terminal).toEqual({
      state: "failed",
      last_error: "attempts_exhausted",
      ref_count: 1,
      reserved_bytes: 0,
      pins: 0,
    });
  });

  it("fails closed when the saved destination credential is revoked", async () => {
    const jobId = await startCrossOwnerCopy(
      env,
      destinationUser,
      {
        sourceNodeId: "source-file",
        sourceRootId: "root",
        destinationParentId: "destination-root",
      },
      async () => Promise.resolve(),
    );
    await env.DB.prepare("UPDATE sessions SET revoked_at=?1 WHERE id='destination-session'")
      .bind(Date.now())
      .run();
    await expect(processCrossOwnerCopy(env, jobId)).rejects.toThrow("copy_job_not_claimed");
    const job = await env.DB.prepare("SELECT state,attempt FROM bulk_jobs WHERE id=?1")
      .bind(jobId)
      .first();
    expect(job).toEqual({ state: "pending", attempt: 0 });
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE parent_id='destination-root'").first(),
    ).resolves.toBeNull();
  });
});
