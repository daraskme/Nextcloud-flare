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

it.each(["single", "multipart", "settled", "abort-prepared", "aborted"])(
  "round-trips frozen copy data, holds and cleanup receipts through SQL restore (%s)",
  async (mode) => {
    const aborting = mode === "abort-prepared" || mode === "aborted",
      multipart = mode === "multipart" || aborting,
      settled = mode === "settled" || mode === "aborted",
      stopped = settled || aborting;
    const sourceBytes = multipart ? 9 * 1024 * 1024 : 3;
    const versions = await migrations(),
      source = initialize(
        ":memory:",
        versions.filter((m) => m.name < "0054_"),
      ),
      target = initialize(":memory:", versions);
    const directory = await mkdtemp(join(tmpdir(), "copy-job-backup-"));
    try {
      for (const prefix of ["source", "target"])
        for (const s of foundationFixture(prefix).statements)
          source
            .prepare(
              prefix === "source" && s.sql.startsWith("INSERT INTO blobs")
                ? s.sql.replace(",3,?", "," + sourceBytes + ",?")
                : s.sql,
            )
            .run(...(s.values ?? []));
      const op = "op_" + "a".repeat(64),
        job = "copy_" + "a".repeat(64);
      source.exec(`INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES('source-b',${sourceBytes},'physical-etag',1);
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
        transferBytes: sourceBytes,
        logicalBytes: sourceBytes,
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
          "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,'target-u',?,'reserved',10000,1)",
        )
        .run(job + "_r00001", sourceBytes);
      source
        .prepare("INSERT INTO blob_pins VALUES(?,'source-b','copy',10000,1)")
        .run(job + "_p00001");
      source
        .prepare(
          "INSERT INTO copy_job_blobs(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id) VALUES(?,?,?,?,?)",
        )
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
      const oldMapping = source.prepare("SELECT * FROM copy_job_blobs").get();
      source.exec(versions.find((m) => m.name === "0054_copy_put.sql").sql);
      expect(source.prepare("SELECT * FROM copy_job_blobs").get()).toEqual({
        ...oldMapping,
        transfer_state: "pending",
        transfer_attempt: null,
        transfer_claim: null,
        transfer_sha256: null,
        transfer_node_id: null,
      });
      source.exec(versions.find((m) => m.name === "0055_copy_multipart.sql").sql);
      if (multipart) {
        const id = job + "_b00001",
          key = "u/target-u/b/" + id,
          init = randomUUID(),
          part = randomUUID(),
          claim = randomUUID();
        source.exec("UPDATE control SET maintenance=0");
        source
          .prepare(
            "UPDATE copy_job_blobs SET transfer_mode='multipart',transfer_state='claimed',transfer_attempt=?,transfer_claim=?,transfer_node_id='source-f'",
          )
          .run(init, claim);
        source
          .prepare(
            "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,'target-u',?,?,?,'staging',1)",
          )
          .run(id, key, sourceBytes, '"b-' + id + '"');
        source
          .prepare(
            "INSERT INTO copy_multipart_uploads(destination_blob_id,init_attempt,init_claim,part_bytes,part_count,state) VALUES(?,?,?,8388608,2,'creating')",
          )
          .run(id, init, claim);
        const native = (kind, attempt) =>
          source
            .prepare(
              "INSERT INTO r2_write_attempts VALUES(?,?,1,'target-u',?,?,2,1,'succeeded',2,?)",
            )
            .run(randomUUID(), randomUUID(), kind, key, JSON.stringify([job, "source-b", attempt]));
        native("copy.multipart.create", init);
        source
          .prepare(
            "UPDATE copy_multipart_uploads SET r2_upload_id='saved-upload',state='uploading' WHERE destination_blob_id=?",
          )
          .run(id);
        source
          .prepare("INSERT INTO copy_multipart_parts VALUES(?,1,8388608,?,?,'claimed',NULL,NULL)")
          .run(id, part, claim);
        native("copy.multipart.part", part);
        source
          .prepare(
            "UPDATE copy_multipart_parts SET state='stored',sha256=?,etag='saved-part' WHERE destination_blob_id=?",
          )
          .run("f".repeat(64), id);
        source
          .prepare("UPDATE bulk_jobs SET state='running',checkpoint=? WHERE id=?")
          .run(JSON.stringify({ v: 1, blob: 0, offset: 8388608 }), job);
        source.exec("UPDATE control SET maintenance=1");
      }
      for (const version of versions.filter(
        (m) => m.name > "0055_copy_multipart.sql" && m.name < "0058_",
      ))
        source.exec(version.sql);
      const admission = (kind) => {
        const id = randomUUID();
        source
          .prepare(`INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until,system,maintenance)
            VALUES(?,?,'target-s',1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000,1,1)`)
          .run(id, `system:copy.${kind}:${randomUUID()}`);
        source
          .prepare(
            "UPDATE mutation_admissions SET state='active',granted_at=strftime('%s','now')*1000,expires_at=strftime('%s','now')*1000+30000 WHERE id=?",
          )
          .run(id);
        return () =>
          source
            .prepare(
              "UPDATE mutation_admissions SET state='closed',committed_at=strftime('%s','now')*1000 WHERE id=?",
            )
            .run(id);
      };
      if (mode === "settled") {
        const stop = admission("stop");
        source
          .prepare(
            "UPDATE bulk_jobs SET state='failed',error_code='copy_expired',stopped_at=strftime('%s','now')*1000,stop_epoch=1 WHERE id=?",
          )
          .run(job);
        source.prepare("UPDATE outbox SET state='failed' WHERE payload_ref=?").run(job);
        stop();
        const cleanup = admission("cleanup");
        source
          .prepare(`INSERT INTO copy_cleanup_receipts(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,bytes,disposition,epoch,settled_at)
          SELECT job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,?,'unwritten',1,strftime('%s','now')*1000 FROM copy_job_blobs WHERE job_id=?`)
          .run(sourceBytes, job);
        source.prepare("UPDATE reservations SET state='released' WHERE id=?").run(job + "_r00001");
        source.prepare("DELETE FROM copy_job_blobs WHERE job_id=?").run(job);
        source.prepare("DELETE FROM blob_pins WHERE pin_id=?").run(job + "_p00001");
        cleanup();
      }
      const oldReceipts = source.prepare("SELECT * FROM copy_cleanup_receipts").all();
      for (const version of versions.filter((m) => m.name >= "0058_")) source.exec(version.sql);
      expect(source.prepare("SELECT * FROM copy_cleanup_receipts").all()).toEqual(oldReceipts);
      if (aborting) {
        const stop = admission("stop");
        source
          .prepare(
            "UPDATE bulk_jobs SET state='failed',error_code='copy_expired',stopped_at=strftime('%s','now')*1000,stop_epoch=1 WHERE id=?",
          )
          .run(job);
        source.prepare("UPDATE outbox SET state='failed' WHERE payload_ref=?").run(job);
        stop();
        const prepare = admission("multipart-abort"),
          attempt = randomUUID(),
          now = Date.now(),
          id = job + "_b00001";
        source
          .prepare(
            "UPDATE copy_multipart_uploads SET abort_attempt=?,abort_epoch=1,abort_started_at=?,abort_deadline=? WHERE destination_blob_id=?",
          )
          .run(attempt, now, now + 4000, id);
        prepare();
        if (mode === "aborted") {
          source
            .prepare(
              "INSERT INTO r2_write_attempts VALUES(?,?,1,'target-u','multipart.abort',?,?,?,'succeeded',?,?)",
            )
            .run(
              randomUUID(),
              randomUUID(),
              "u/target-u/b/" + id,
              now + 4000,
              now,
              now,
              JSON.stringify(["copy", job, "source-b", attempt]),
            );
          const cleanup = admission("cleanup");
          source
            .prepare(`INSERT INTO copy_cleanup_receipts(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,bytes,disposition,epoch,settled_at)
            SELECT job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,?,'aborted',1,? FROM copy_job_blobs WHERE job_id=?`)
            .run(sourceBytes, now, job);
          source
            .prepare("UPDATE reservations SET state='released' WHERE id=?")
            .run(job + "_r00001");
          source.prepare("UPDATE blobs SET state='deleted' WHERE id=?").run(id);
          source.prepare("DELETE FROM copy_multipart_parts WHERE destination_blob_id=?").run(id);
          source.prepare("DELETE FROM copy_multipart_uploads WHERE destination_blob_id=?").run(id);
          source.prepare("DELETE FROM copy_job_blobs WHERE job_id=?").run(job);
          source.prepare("DELETE FROM blob_pins WHERE pin_id=?").run(job + "_p00001");
          cleanup();
        }
      }
      // An expired invocation is exported with its spent budget and retry count intact.
      // The native backup barrier refuses a live invocation; expiry never settles its holds.
      if (!stopped)
        source
          .prepare(
            "INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt,r2_calls) VALUES(?,'expired-claim',1,0,4,9)",
          )
          .run(job);
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
      expect(
        target
          .prepare("SELECT claim_token,expires_at,attempt,r2_calls FROM job_leases WHERE job_id=?")
          .get(job),
      ).toEqual(
        stopped
          ? undefined
          : { claim_token: "expired-claim", expires_at: 0, attempt: 4, r2_calls: 9 },
      );
      expect(target.prepare("SELECT reserved_bytes FROM users WHERE id='target-u'").get()).toEqual({
        reserved_bytes: settled ? 0 : sourceBytes,
      });
      expect(target.prepare("SELECT ref_count FROM blobs WHERE id='source-b'").get()).toEqual({
        ref_count: settled ? 1 : 2,
      });
      if (settled) {
        expect(
          target
            .prepare("SELECT disposition,bytes FROM copy_cleanup_receipts WHERE job_id=?")
            .get(job),
        ).toEqual({
          disposition: mode === "aborted" ? "aborted" : "unwritten",
          bytes: sourceBytes,
        });
        for (const sql of [
          "UPDATE copy_cleanup_receipts SET bytes=bytes",
          "DELETE FROM copy_cleanup_receipts",
        ])
          expect(() => target.exec(sql)).toThrow(
            /backup_frozen|immutable_copy_cleanup|copy_cleanup_receipt_required/,
          );
      }
      // Recreating triggers can change which of the two rejecting guards fires first.
      expect(() => target.exec("UPDATE copy_job_chunks SET data=data")).toThrow(
        /backup_frozen|immutable_copy_chunk/,
      );
    } finally {
      source.close();
      target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
