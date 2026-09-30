import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { ORPHAN_GRACE_MS } from "../../src/jobs/orphanInventory";
import { foundationFixture } from "./foundation";

export function orphanBucket(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.BLOBS, {
    get(target, key) {
      const value = Reflect.get(overrides, key) ?? Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function orphanFixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/unknown`;
  const object = (await env.BLOBS.put(key, "abc"))!;
  const bucket = orphanBucket({
    list: (options) => env.BLOBS.list({ ...options, prefix: `u/${f.ids.user}/` }),
  });
  return { ...f, key, object, bucket };
}
export async function trackOrphan(
  f: Awaited<ReturnType<typeof orphanFixture>>,
  age = ORPHAN_GRACE_MS + 2000,
) {
  const seen = Date.now() - age;
  await env.DB.prepare(`INSERT INTO orphan_objects(r2_key,owner_key,blob_key,owner_id,bytes,r2_etag,r2_version,
    uploaded_at,first_seen_at,last_seen_at,epoch) VALUES(?,?,'unknown',?,3,?,?,?,?,?,1)`)
    .bind(
      f.key,
      f.ids.user,
      f.ids.user,
      f.object.etag,
      f.object.version,
      f.object.uploaded.getTime(),
      seen,
      seen,
    )
    .run();
}
