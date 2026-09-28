import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ControlImageTransforms } from "../../src/do/controlImageTransforms";
import { CONTROL_NAME } from "../../src/do/controlName";
import { planImageTransform, transformImage } from "../../src/media/images/transform";
import { davPutFixture } from "./davPut";
import { imageBytes } from "./images/encoded";
import { acquireGlobalMutation, acquireMutation, mutationEnv } from "./mutationAdmission";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
export async function imageDerivativeFixture() {
  const bytes = imageBytes("red.png"),
    f = await davPutFixture(bytes.length);
  const result = await f.run({}, new Blob([bytes]).stream());
  if (result.kind !== "terminal" || result.operation.state !== "committed")
    throw new Error("fixture_upload");
  const node =
    (await env.DB.prepare(`SELECT n.id,n.current_blob_id AS blob,b.r2_key AS key,b.size,s.r2_etag AS etag
    FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN blob_storage s ON s.blob_id=b.id WHERE n.last_op_id=? AND n.kind='file'`)
      .bind(result.operation.id)
      .first<{ id: string; blob: string; key: string; size: number; etag: string }>())!;
  const outboxId = result.operation.id + "_event",
    claimToken = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE outbox SET state='sent',dispatch_token=?,dispatch_expires_at=?,claim_token=?,claim_expires_at=? WHERE outbox_id=?",
  )
    .bind(crypto.randomUUID(), Date.now() + 30000, claimToken, Date.now() + 30000, outboxId)
    .run();
  const plan = await planImageTransform(
    { size: bytes.length, read: async (o, n) => bytes.slice(o, o + n) },
    "sm",
  );
  const output = await transformImage(
    env.IMAGES,
    plan,
    new Blob([bytes]).stream(),
    new AbortController().signal,
  );
  const grant = await runInDurableObject(control(), async (_, state) => {
    const ledger = new ControlImageTransforms(
      state.storage,
      env.DB,
      () => {},
      acquireMutation,
      () =>
        acquireGlobalMutation({
          permitId: `global:images.settle:${crypto.randomUUID()}`,
          epoch: 1,
          deadline: Date.now() + 5000,
        }),
    );
    const g = await ledger.begin({
      id: crypto.randomUUID(),
      epoch: 1,
      ownerId: f.ids.user,
      blobId: node.blob,
      outboxId,
      claimToken,
      variant: "sm",
      generator: "image-webp-v1",
      deadline: Date.now() + 5000,
      expiresAt: Date.now() + 25000,
      source: {
        nodeId: node.id,
        parentId: f.ids.folder,
        key: node.key,
        etag: node.etag,
        size: node.size,
        width: 16,
        height: 12,
      },
    });
    await ledger.finish(g, "succeeded", {
      bytes: output.bytes.length,
      width: 16,
      height: 12,
      sha256: output.sha256,
    });
    return g;
  });
  const saved = () =>
    env.DB.prepare("SELECT * FROM derivative_results WHERE id=?")
      .bind("image_" + grant.id)
      .first<Record<string, unknown>>();
  return { ...f, node, output, grant, saved, app: mutationEnv() };
}
