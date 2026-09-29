import { env } from "cloudflare:workers";
import type { ArchiveDerivativeGrant } from "../../src/db/archiveDerivative";
import { archiveOriginalFromGrant } from "../../src/db/archiveDerivative";
import { encodeArchiveIndex } from "../../src/media/archive/codec";
import { inspectArchive } from "../../src/media/archive/index";
import { putFile } from "../../src/services/putFile";
import { archiveFixture, memoryArchive } from "./archive";
import { davPutFixture } from "./davPut";
import { mutationEnv } from "./mutationAdmission";

export async function archiveStorageFixture(
  bytes = archiveFixture().bytes,
  name = "book.cbz",
  prepareOutput = true,
) {
  const f = await davPutFixture(bytes.length);
  const saved = await putFile(f.app, { ...f.input, name, body: new Blob([bytes]).stream() });
  if (saved.kind !== "terminal") throw new Error("fixture_upload");
  const node =
    (await env.DB.prepare(`SELECT n.id,n.current_blob_id AS blob,n.parent_id AS parent,b.r2_key AS key,b.size,s.r2_etag AS etag
    FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN blob_storage s ON s.blob_id=b.id WHERE n.last_op_id=? AND n.kind='file'`)
      .bind(saved.operation.id)
      .first<{
        id: string;
        blob: string;
        parent: string;
        key: string;
        size: number;
        etag: string;
      }>())!;
  const outboxId = saved.operation.id + "_event",
    token = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE outbox SET state='sent',dispatch_token=?,dispatch_expires_at=?,claim_token=?,claim_expires_at=? WHERE outbox_id=?",
  )
    .bind(crypto.randomUUID(), Date.now() + 30000, token, Date.now() + 30000, outboxId)
    .run();
  const g: ArchiveDerivativeGrant = {
    id: crypto.randomUUID(),
    ownerId: f.ids.user,
    blobId: node.blob,
    epoch: 1,
    outboxId,
    claimToken: token,
    expiresAt: Date.now() + 25000,
    source: {
      nodeId: node.id,
      parentId: node.parent,
      key: node.key,
      size: node.size,
      etag: node.etag,
    },
  };
  const output =
    prepareOutput && bytes.length >= 22
      ? await encodeArchiveIndex(
          await inspectArchive(memoryArchive(bytes)),
          archiveOriginalFromGrant(g),
        )
      : null;
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(outboxId).run();
  const row = () =>
    env.DB.prepare("SELECT * FROM archive_derivative_objects WHERE source_blob_id=?")
      .bind(node.blob)
      .first<Record<string, unknown>>();
  return { ...f, app: mutationEnv(), node, grant: g, output, outboxId, release, row, bytes };
}
