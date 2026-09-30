import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { foundationFixture } from "./foundation";
import { inventoryEnv, partsXml, partXml, uploadsXml, uploadXml } from "./s3Inventory";

export async function multipartBucketFixture(createOwner = true, keyOverride?: string) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  if (createOwner) await atomicBatch(env.DB, f.statements);
  const key = keyOverride ?? `u/${f.ids.user}/b/lost-${crypto.randomUUID()}`;
  const handle = await env.BLOBS.createMultipartUpload(key);
  await handle.uploadPart(1, new TextEncoder().encode("abc"));
  return { ...f, key, handle };
}
export function multipartBucketClient(
  f: Awaited<ReturnType<typeof multipartBucketFixture>>,
  jurisdiction: "default" | "eu" = "default",
) {
  const uploads = vi.fn(
    async (_request: Request) =>
      new Response(uploadsXml({ uploads: uploadXml(f.key, f.handle.uploadId) })),
  );
  const parts = vi.fn(
    async (_request: Request) =>
      new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: partXml(1, 3) })),
  );
  const binding = vi.fn(async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body));
  const fetch = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith(`/${BINDING_PROBE_KEY}`)) return binding();
    return url.searchParams.has("uploads") ? uploads(request) : parts(request);
  };
  return {
    inventory: new R2S3Inventory(
      { ...inventoryEnv, R2_INVENTORY_JURISDICTION: jurisdiction },
      { fetch },
    ),
    uploads,
    parts,
    binding,
    fetch,
  };
}
