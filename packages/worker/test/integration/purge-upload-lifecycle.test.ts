import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { dispatchTreeJob, treeJobId } from "../../src/jobs/treeJobStore";
import { processTreeJob } from "../../src/jobs/treeJobWorker";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import { purgeTrash } from "../../src/services/purgeTrash";
import { trashNode } from "../../src/services/trashNode";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload, reserveMultipartUpload } from "../../src/services/uploads/create";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { multipartCleanupFixture, singleCleanupFixture } from "../fixtures/uploadCleanup";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

type Fixture = ReturnType<typeof foundationFixture>;
const principal = (f: Fixture) => ({
  kind: "user" as const,
  user_id: f.ids.user,
  credential_id: f.ids.credential,
  epoch: 1,
});

async function progress(operationId: string) {
  const id = treeJobId(operationId);
  for (let step = 0; step < 20; step++) {
    await dispatchTreeJob(mutationEnv(), { async send() {} }, id, 1);
    const result = await processTreeJob(mutationEnv(), id);
    if (result !== "progressed") return result;
  }
  throw new Error("fixture_tree_not_terminal");
}

async function trash(f: Fixture, mode: "sync" | "async" = "sync") {
  if (mode === "async")
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<998)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      SELECT ?||n,?,?,?,?||n,?||n,'folder',1,1 FROM seq`,
    )
      .bind(`${f.ids.user}_child_`, f.ids.space, f.ids.user, f.ids.folder, "Child-", "child-")
      .run();
  const result = await trashNode(admitted(), {
    principal: principal(f),
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    lockTokens: [],
  });
  if (result.kind !== "terminal") throw new Error("fixture_trash_unknown");
  if (mode === "async") expect(await progress(result.operation.id)).toBe("completed");
  else expect(result.operation.state).toBe("committed");
  return result.operation.id;
}

function purge(f: Fixture, trashOpId: string, db = env.DB) {
  return purgeTrash(admitted(db), {
    principal: principal(f),
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    trashOpId,
  });
}

async function expectBlocked(f: Fixture, trashOpId: string, mode: "sync" | "async") {
  const result = await purge(f, trashOpId);
  if (result.kind !== "terminal") throw new Error("fixture_purge_unknown");
  if (mode === "async") expect(await progress(result.operation.id)).toBe("retry");
  else expect(result.operation.state).toBe("failed");
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
      .bind(trashOpId)
      .first("state"),
  ).toBe("trashed");
  expect(
    await env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(f.ids.folder).first("id"),
  ).toBe(f.ids.folder);
  return result.operation.id;
}

async function retry(f: Fixture, trashOpId: string, mode: "sync" | "async", operationId: string) {
  if (mode === "async") {
    // Model the next Queue delivery after the failed finalize claim expires.
    await env.DB.prepare("UPDATE job_leases SET expires_at=1 WHERE job_id=?")
      .bind(treeJobId(operationId))
      .run();
    expect(await processTreeJob(mutationEnv(), treeJobId(operationId))).toBe("completed");
  } else expect(await purge(f, trashOpId)).toMatchObject({ operation: { state: "committed" } });
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
      .bind(trashOpId)
      .first("state"),
  ).toBe("purged");
}

async function uploadFixture(mode: "single" | "multipart" = "single") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1_000);
  await atomicBatch(env.DB, f.statements);
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: secret }));
  const upload = await (mode === "single" ? createSingleUpload : reserveMultipartUpload)(
    mutationEnv(),
    {
      principal: principal(f),
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      parentId: f.ids.folder,
      name: "upload.txt",
      declaredSize: 3,
    },
    capabilities,
  );
  return { ...f, capabilities, upload };
}

it("keeps a dispatched single PUT and its reservation while the parent is trashed", async () => {
  const f = await uploadFixture();
  let started!: () => void;
  let release!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          started();
          await pending;
          return target.put(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const written = writeSingleUpload(
    { ...admitted(), BLOBS: bucket },
    principal(f),
    f.upload.id,
    f.upload.capability,
    f.capabilities,
    new Blob(["abc"]).stream(),
    3,
  ).then(
    () => ({ failed: false }),
    () => ({ failed: true }),
  );
  try {
    await dispatched;
    const trashOpId = await trash(f);
    await expectBlocked(f, trashOpId, "sync");
    expect(
      await env.DB.prepare(
        "SELECT u.in_flight,r.state FROM uploads u JOIN reservations r ON r.id=u.reservation_id WHERE u.id=?",
      )
        .bind(f.upload.id)
        .first(),
    ).toEqual({ in_flight: 1, state: "reserved" });
  } finally {
    release();
    expect(await written).toEqual({ failed: true });
  }
  expect(
    await env.DB.prepare("SELECT reserved_bytes,physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first(),
  ).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
});

it.each([
  ["single", "created"],
  ["multipart", "created"],
  ["single", "completed"],
] as const)("allows purging a %s upload in state %s", async (mode, state) => {
  const f = await uploadFixture(mode);
  if (state === "completed") {
    await writeSingleUpload(
      admitted(),
      principal(f),
      f.upload.id,
      f.upload.capability,
      f.capabilities,
      new Blob(["abc"]).stream(),
      3,
    );
    expect(
      await completeSingleUpload(
        admitted(),
        principal(f),
        f.upload.id,
        f.upload.capability,
        f.capabilities,
        crypto.randomUUID(),
        [],
      ),
    ).toMatchObject({ operation: { state: "committed" } });
  }
  expect(await purge(f, await trash(f))).toMatchObject({ operation: { state: "committed" } });
  expect(
    await env.DB.prepare("SELECT id FROM uploads WHERE id=?").bind(f.upload.id).first(),
  ).toBeNull();
});

it.each(["sync", "async"] as const)(
  "retains an uncertain single attempt even with in_flight=0, then permits absent cleanup (%s)",
  async (mode) => {
    const f = await singleCleanupFixture("aborted");
    const trashOpId = await trash(f, mode);
    const operationId = await expectBlocked(f, trashOpId, mode);
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(f.reservation)
        .first("state"),
    ).toBe("reserved");
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
    await retry(f, trashOpId, mode, operationId);
  },
);

it.each(["sync", "async"] as const)(
  "retains an unclosed multipart upload until local cleanup confirms its closure (%s)",
  async (mode) => {
    const f = await multipartCleanupFixture({ state: "aborting" });
    const trashOpId = await trash(f, mode);
    const operationId = await expectBlocked(f, trashOpId, mode);
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(f.reservation)
        .first("state"),
    ).toBe("reserved");
    expect(await repairMultipartUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
    await retry(f, trashOpId, mode, operationId);
  },
);

it.each(["sync", "async"] as const)(
  "allows a physically accounted cleanup handoff without waiting for the GC grace (%s)",
  async (mode) => {
    const f = await singleCleanupFixture("aborted");
    await env.BLOBS.put(f.key, "abc", { customMetadata: f.metadata });
    const trashOpId = await trash(f, mode);
    const operationId = await expectBlocked(f, trashOpId, mode);
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ queued: 1 });
    await retry(f, trashOpId, mode, operationId);
    expect(
      await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("physical_bytes"),
    ).toBe(3);
    expect(
      await env.DB.prepare("SELECT state FROM gc_candidates WHERE blob_id=?")
        .bind(f.blob)
        .first("state"),
    ).toBe("candidate");
  },
);

it("rechecks transfer state in the purge transaction", async () => {
  const f = await uploadFixture();
  const trashOpId = await trash(f);
  // Inject a persisted dispatch at the batch boundary to ensure the guard is
  // authoritative at commit, even if earlier reads saw a never-started upload.
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE trash_ops SET state='purging'"),
    async () => {
      await env.DB.prepare(
        "UPDATE uploads SET state='receiving',write_attempt_id=?,write_lease_expires_at=?,in_flight=1 WHERE id=?",
      )
        .bind(crypto.randomUUID(), Date.now() + 900_000, f.upload.id)
        .run();
    },
    false,
  );
  expect(await purge(f, trashOpId, db)).toMatchObject({ operation: { state: "failed" } });
  expect(
    await env.DB.prepare(
      "SELECT u.in_flight,r.state FROM uploads u JOIN reservations r ON r.id=u.reservation_id WHERE u.id=?",
    )
      .bind(f.upload.id)
      .first(),
  ).toEqual({ in_flight: 1, state: "reserved" });
});

it.each(["sync", "async"] as const)(
  "purges indexed files and retained completed upload history (%s)",
  async (mode) => {
    const f = await uploadFixture();
    for (let index = 0; index < 6; index++) {
      const upload =
        index === 0
          ? f.upload
          : await createSingleUpload(
              mutationEnv(),
              {
                principal: principal(f),
                requestId: crypto.randomUUID(),
                spaceId: f.ids.space,
                parentId: f.ids.folder,
                name: `media-${index}.txt`,
                declaredSize: 3,
              },
              f.capabilities,
            );
      await writeSingleUpload(
        admitted(),
        principal(f),
        upload.id,
        upload.capability,
        f.capabilities,
        new Blob(["abc"]).stream(),
        3,
      );
      const completed = await completeSingleUpload(
        admitted(),
        principal(f),
        upload.id,
        upload.capability,
        f.capabilities,
        crypto.randomUUID(),
        [],
      );
      if (completed.kind !== "terminal" || !completed.operation.result?.nodeId)
        throw new Error("fixture_upload_failed");
      const nodeId = completed.operation.result.nodeId;
      if (index < 3) {
        const deleted = await trashNode(admitted(), {
          principal: principal(f),
          requestId: crypto.randomUUID(),
          spaceId: f.ids.space,
          nodeId,
          lockTokens: [],
        });
        if (deleted.kind !== "terminal") throw new Error("fixture_trash_failed");
        expect(await purge(f, deleted.operation.id)).toMatchObject({
          operation: { state: "committed" },
        });
      }
    }
    const trashOpId = await trash(f, mode);
    const deleted = await purge(f, trashOpId);
    if (deleted.kind !== "terminal") throw new Error("fixture_purge_failed");
    if (mode === "async") expect(await progress(deleted.operation.id)).toBe("completed");
    else expect(deleted.operation.state).toBe("committed");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM search_index WHERE space_id=?")
        .bind(f.ids.space)
        .first("count"),
    ).toBe(0);
    // FTS5's integrity command verifies both postings and external content rows.
    await env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)",
    ).run();
    expect(
      await env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(f.ids.folder).first(),
    ).toBeNull();
  },
);
