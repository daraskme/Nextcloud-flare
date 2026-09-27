import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import {
  loadTargetManifest,
  stageTargetManifest,
  type TargetEntry,
} from "../../src/services/targetManifest";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("stages a hash-pinned target set in R2 and rejects a changed object", async () => {
  const targets: TargetEntry[] = [
    { spaceId: "space", nodeId: "node-b", blobId: "blob-b", purpose: "content", size: 2 },
    { spaceId: "space", nodeId: "node-a", blobId: "blob-a", purpose: "content", size: 1 },
  ];
  const f = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  const record = await stageTargetManifest(env.BLOBS, targets, {
    env: mutationEnv(),
    epoch: 1,
    ownerId: f.ids.user,
  });
  try {
    expect(record.ref).toBe(`target-sets/${record.id}`);
    expect(record.totalBytes).toBe(3);
    expect(
      (await loadTargetManifest(env.BLOBS, record)).targets.map((item) => item.nodeId),
    ).toEqual(["node-a", "node-b"]);
    await env.BLOBS.put(record.ref, "{}");
    await expect(loadTargetManifest(env.BLOBS, record)).rejects.toThrow(/invalid_target_manifest/);
  } finally {
    await env.BLOBS.delete(record.ref);
  }
});
