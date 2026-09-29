import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { CONTROL_NAME } from "../../src/do/controlName";
import { archiveIndexReadBudget } from "../../src/jobs/archiveQueue";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload } from "../../src/services/uploads/create";
import { archiveFixture } from "../fixtures/archive";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { davBucket } from "../fixtures/davPut";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await runInDurableObject(control, (_, state) => state.storage.deleteAll());
  await evictDurableObject(control);
});
async function fixture(bytes = archiveFixture().bytes, name = "book.cbz") {
  const f = await archiveStorageFixture(bytes, name, false);
  await f.release();
  const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  const app = { ...f.app, BLOBS: davBucket({ put }) };
  const library = () =>
    env.DB.prepare("SELECT * FROM library_items WHERE node_id=?").bind(f.node.id).first();
  const alias = () =>
    env.DB.prepare("SELECT * FROM archive_index WHERE node_id=?").bind(f.node.id).first();
  return { ...f, app, put, library, alias };
}

it.each(["zip", "CBZ", "epub"])(
  "indexes a new %s upload once through the real consumer",
  async (suffix) => {
    const f = await fixture(
      archiveFixture([{ name: "page10.jpg" }, { name: "page2.png" }]).bytes,
      "book." + suffix,
    );
    const budget = archiveIndexReadBudget();
    expect(
      await consumeOutbox(f.app, f.outboxId, Date.now() + 25000, undefined, undefined, budget),
    ).toBe("completed");
    expect(budget.reads).toBe(1);
    expect(budget.bytes).toBe(f.bytes.length);
    expect(await f.row()).toMatchObject({ state: "published" });
    expect(await f.library()).toMatchObject({
      kind: suffix.toLowerCase(),
      page_count: suffix === "epub" ? null : 2,
      blob_id: f.node.blob,
    });
    expect(await f.alias()).toMatchObject({ entry_count: 2, blob_id: f.node.blob });
    expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
    expect(f.put).toHaveBeenCalledTimes(1);
  },
);

it.each(["stored", "published"])(
  "resumes %s output without another archive read or PUT",
  async (stage) => {
    const f = await fixture(),
      budget = archiveIndexReadBudget();
    const db = injectBatch(
      (sql) =>
        sql.includes(
          stage === "stored"
            ? "UPDATE archive_derivative_objects SET state='published'"
            : "INSERT INTO archive_index",
        ),
      async () => {
        throw new Error("completion_interrupted");
      },
      false,
    );
    expect(
      await consumeOutbox(
        { ...f.app, DB: db },
        f.outboxId,
        Date.now() + 25000,
        undefined,
        undefined,
        budget,
      ),
    ).toBe("retry");
    expect(await f.row()).toMatchObject({ state: stage });
    expect(await f.alias()).toBeNull();
    await f.release();
    expect(
      await consumeOutbox(f.app, f.outboxId, Date.now() + 25000, undefined, undefined, budget),
    ).toBe("completed");
    expect(budget.reads).toBe(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  },
);

it("recovers the final transaction ACK without repeating its index write", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO archive_index"),
    async () => {
      throw new Error("lost_completion_ack");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.outboxId)).toBe("completed");
  expect(await f.alias()).not.toBeNull();
  expect(f.put).toHaveBeenCalledTimes(1);
});

it.each(["hidden", "credential", "revision"])(
  "rolls back library publication when %s changes at final commit",
  async (change) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO archive_index"),
      async () => {
        if (change === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
        if (change === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE user_id=?")
            .bind(Date.now(), f.ids.user)
            .run();
        if (change === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
            .bind(f.node.id)
            .run();
      },
      false,
    );
    expect(await consumeOutbox({ ...f.app, DB: db }, f.outboxId)).toBe("retry");
    expect(await f.alias()).toBeNull();
    expect(await f.library()).toBeNull();
    expect(await f.row()).toMatchObject({ state: "published" });
  },
);

it.each([new Uint8Array(3), new Uint8Array(64), archiveFixture([{ name: "../bad.jpg" }]).bytes])(
  "records malformed archives without producing a storage object",
  async (bytes) => {
    const f = await fixture(bytes);
    expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
    expect(
      await env.DB.prepare(
        "SELECT state,attempts FROM derivative_results WHERE blob_id=? AND kind='archive_index'",
      )
        .bind(f.node.blob)
        .first(),
    ).toEqual({ state: "failed", attempts: 0 });
    expect(await f.alias()).toBeNull();
    expect(await f.library()).toMatchObject({ page_count: null });
    expect(f.put).not.toHaveBeenCalled();
  },
);

it("keeps read-budget exhaustion retryable without a terminal format failure", async () => {
  const f = await fixture(),
    budget = { ...archiveIndexReadBudget(), maxReads: 0 };
  expect(
    await consumeOutbox(f.app, f.outboxId, Date.now() + 25000, undefined, undefined, budget),
  ).toBe("retry");
  expect(await f.row()).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM derivative_results WHERE blob_id=? AND kind='archive_index'",
    )
      .bind(f.node.blob)
      .first(),
  ).toBeNull();
  expect(f.put).not.toHaveBeenCalled();
  await f.release();
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
});

it("does not infer an archive job for other filename extensions", async () => {
  const f = await fixture(archiveFixture().bytes, "file.bin");
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
  expect(await f.row()).toBeNull();
  expect(await f.library()).toBeNull();
  expect(f.put).not.toHaveBeenCalled();
});

it.each(["edit", "upload_only"] as const)(
  "indexes an anonymous %s upload using its original write authority",
  async (role) => {
    const t = await publicShareFixture(role),
      bytes = archiveFixture().bytes,
      principal = publicPrincipal(t.session);
    const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: t.key }));
    const upload = await createSingleUpload(
      t.app,
      {
        principal,
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        parentId: t.f.ids.folder,
        name: "anonymous.cbz",
        declaredSize: bytes.length,
      },
      capabilities,
    );
    await writeSingleUpload(
      t.app,
      principal,
      upload.id,
      upload.capability,
      capabilities,
      new Blob([bytes]).stream(),
      bytes.length,
    );
    const completed = await completeSingleUpload(
      t.app,
      principal,
      upload.id,
      upload.capability,
      capabilities,
      crypto.randomUUID(),
      [],
    );
    if (completed.kind !== "terminal") throw new Error("anonymous_fixture_failed");
    const event = completed.operation.id + "_event";
    await env.DB.prepare("UPDATE outbox SET state='sent' WHERE outbox_id=?").bind(event).run();
    expect(await consumeOutbox(t.app, event)).toBe("completed");
    expect(
      await env.DB.prepare(
        "SELECT a.entry_count,l.page_count FROM archive_index a JOIN library_items l ON l.node_id=a.node_id JOIN nodes n ON n.id=a.node_id WHERE n.last_op_id=?",
      )
        .bind(completed.operation.id)
        .first(),
    ).toEqual({ entry_count: 1, page_count: 1 });
    // Processing the owner's bytes grants no listing/read access to upload-only sessions.
    if (role === "upload_only")
      expect(
        await env.DB.prepare("SELECT 1 FROM share_actions WHERE share_id=? AND action='read'")
          .bind(t.share.id)
          .first(),
      ).toBeNull();
  },
);
