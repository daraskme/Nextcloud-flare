import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";
import { exportData } from "../backup/export.mjs";
import {
  importData,
  initialize,
  migrations,
  schemaDigest,
  schemaQuery,
  specs,
  tableDigests,
} from "../backup/snapshot.mjs";

it("round-trips a frozen copy job, binary manifest chunks and live holds through isolated SQL restore", async () => {
  const versions = await migrations(),
    source = initialize(":memory:", versions),
    target = initialize(":memory:", versions);
  const directory = await mkdtemp(join(tmpdir(), "copy-job-backup-"));
  try {
    for (const prefix of ["source", "target"])
      for (const s of foundationFixture(prefix).statements)
        source.prepare(s.sql).run(...(s.values ?? []));
    const op = "op_" + "a".repeat(64),
      job = "copy_" + "a".repeat(64);
    source.exec(`INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES('source-b',3,'physical-etag',1);
      INSERT INTO shares(id,owner_id,root_node_id,kind,version,created_at) VALUES('source-share','source-u','source-d','internal',1,1);
      INSERT INTO share_grants(share_id,user_id,version) VALUES('source-share','target-u',1);
      INSERT INTO share_actions(share_id,action) VALUES('source-share','read');
      INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','source-s',1,10000,'released');`);
    for (let i = 0; i < 10; i++)
      source
        .prepare("INSERT INTO node_props VALUES(?,?,?,?)")
        .run("source-f", "urn:copy", "p" + i, "あ".repeat(2200) + "\0\r\n'\\quoted");
    const principal = {
      kind: "user",
      user_id: "target-u",
      credential_id: "as:target-session",
      epoch: 1,
      selected_share: { id: "source-share", version: 1 },
    };
    const destination = { spaceId: "target-s", share: null };
    const manifest = {
      version: 1,
      principal,
      destination,
      destinationParentId: "target-d",
      destinationOwnerId: "target-u",
      name: "Copied",
      nameCi: "copied",
      depth: "infinity",
      source: {
        rootId: "source-d",
        spaceId: "source-s",
        ownerId: "source-u",
        generation: 1,
        entries: source
          .prepare(
            "SELECT id,CASE WHEN id='source-d' THEN NULL ELSE parent_id END AS parentId,name,name_ci AS nameCi,kind,revision,current_blob_id AS blobId,client_mtime AS mtime,hidden FROM nodes WHERE id IN ('source-d','source-f') ORDER BY id",
          )
          .all(),
        blobs: source
          .prepare(
            "SELECT id,r2_key AS key,size,'physical-etag' AS etag,content_etag AS contentEtag,sha256_verified AS sha256,mime_sniffed AS mime FROM blobs WHERE id='source-b'",
          )
          .all(),
        properties: source
          .prepare(
            "SELECT node_id AS nodeId,namespace,name,value_xml AS value FROM node_props ORDER BY node_id,namespace,name",
          )
          .all(),
      },
      overwrite: null,
      transferBytes: 3,
      logicalBytes: 3,
    };
    const body = Buffer.from(JSON.stringify(manifest)),
      hash = createHash("sha256").update(body).digest("hex"),
      chunks = Math.ceil(body.length / 65536);
    expect(chunks).toBeGreaterThan(1);
    source
      .prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,selected_share_id,selected_share_version,destination_space_id,operands_json)
      VALUES(?,'user','target-u','as:target-session','source-s','copy.enqueue','claimed','digest',1,'permit',10000,10000,4,1,1,'source-share',1,'target-s',?)`)
      .run(
        op,
        JSON.stringify({
          sourceNodeId: "source-d",
          parentId: "target-d",
          name: "Copied",
          depth: "infinity",
        }),
      );
    source
      .prepare(`INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,manifest_ref,grant_snapshot,node_count,blob_count,created_at,updated_at)
      VALUES(?,'target-u','as:target-session',?,'node.copy','pending',1,?,?,2,1,1,1)`)
      .run(job, op, "d1:copy/" + job, JSON.stringify({ principal, destination }));
    source
      .prepare("INSERT INTO copy_job_manifests VALUES(?,?,?,?,10000)")
      .run(job, hash, body.length, chunks);
    for (let i = 0; i < chunks; i++)
      source
        .prepare("INSERT INTO copy_job_chunks VALUES(?,?,?)")
        .run(job, i, body.subarray(i * 65536, (i + 1) * 65536));
    source
      .prepare(
        "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,'target-u',3,'reserved',10000,1)",
      )
      .run(job + "_r00001");
    source
      .prepare("INSERT INTO blob_pins VALUES(?,'source-b','copy',10000,1)")
      .run(job + "_p00001");
    source
      .prepare("INSERT INTO copy_job_blobs VALUES(?,?,?,?,?)")
      .run(job, "source-b", job + "_b00001", job + "_p00001", job + "_r00001");
    for (const [i, kind] of ["copy_job", "copy_manifest", "copy_holds", "copy_outbox"].entries())
      source.prepare("INSERT INTO operation_steps VALUES(?,?,?,?)").run(op, i + 1, kind, job);
    source
      .prepare(
        "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'copy.requested',?,'pending',1,1,1)",
      )
      .run(op + "_copy", op, job);
    source
      .prepare("UPDATE operations SET state='committed',result_json=? WHERE op_id=?")
      .run(JSON.stringify({ status: 202, jobId: job }), op);
    const token = randomUUID();
    source
      .prepare(
        "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark) VALUES(?,1,'exporting',1,?,?)",
      )
      .run(randomUUID(), token, op);
    source
      .prepare("UPDATE control SET backup_token=?,backup_barrier_op=?,backup_frozen=1")
      .run(token, op);
    const tableSpecs = specs(source),
      path = join(directory, "copy.sql");
    await exportData(path, tableSpecs, async (sql) => source.prepare(sql).all());
    await importData(target, createReadStream(path), specs(target));
    expect(await tableDigests(specs(target), async (sql) => target.prepare(sql).all())).toEqual(
      await tableDigests(tableSpecs, async (sql) => source.prepare(sql).all()),
    );
    expect(schemaDigest(target.prepare(schemaQuery).all())).toBe(
      schemaDigest(source.prepare(schemaQuery).all()),
    );
    const saved = Buffer.concat(
      target
        .prepare("SELECT data FROM copy_job_chunks ORDER BY part")
        .all()
        .map((r) => r.data),
    );
    expect(saved.equals(body)).toBe(true);
    expect(target.prepare("SELECT reserved_bytes FROM users WHERE id='target-u'").get()).toEqual({
      reserved_bytes: 3,
    });
    expect(target.prepare("SELECT ref_count FROM blobs WHERE id='source-b'").get()).toEqual({
      ref_count: 2,
    });
    // Recreating triggers can change which of the two rejecting guards fires first.
    expect(() => target.exec("UPDATE copy_job_chunks SET data=data")).toThrow(
      /backup_frozen|immutable_copy_chunk/,
    );
  } finally {
    source.close();
    target.close();
    await rm(directory, { recursive: true, force: true });
  }
});
