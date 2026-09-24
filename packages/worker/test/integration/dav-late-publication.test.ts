import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode } from "../../src/auth/authorize";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { claimOperation, type OperationIntent } from "../../src/jobs/operations";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import { davPublicationStatements } from "../../src/services/davUpload";
import { putFile } from "../../src/services/putFile";
import { davBucket, davPutFixture as fixture } from "../fixtures/davPut";
import { davUploadHistory as history } from "../fixtures/davUploadHistory";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});

it("publishes a real body taking longer than the 30s permit without holding a namespace slot", async () => {
  const f = await fixture();
  let writer!: ReadableStreamDefaultController<Uint8Array>, signal!: () => void;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
  });
  const began = Date.now();
  const pending = f
    .run(
      {
        BLOBS: davBucket({
          put: (k, b, o) => {
            signal();
            return env.BLOBS.put(k, b, o);
          },
        }),
      },
      body,
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await started;
  try {
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    expect(Date.now() - began).toBeGreaterThanOrEqual(31_000);
    expect(await f.op()).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM permits WHERE space_id=?")
        .bind(f.ids.space)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND state<>'closed'",
      )
        .bind(f.ids.space)
        .first("n"),
    ).toBe(0);
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
    const bodyReleasedAt = Date.now();
    writer.enqueue(new TextEncoder().encode("abc"));
    writer.close();
    expect(await pending).toMatchObject({
      value: { kind: "terminal", operation: { state: "committed" } },
    });
    const permit = await env.DB.prepare(
      "SELECT p.expires_at,p.state,a.granted_at FROM permits p JOIN mutation_admissions a ON a.permit_id=p.permit_id WHERE p.space_id=?",
    )
      .bind(f.ids.space)
      .first<{ expires_at: number; granted_at: number; state: string }>();
    expect(permit!.granted_at).toBeGreaterThanOrEqual(bodyReleasedAt - 1000); // D1 second-resolution clock.
    expect(permit!.expires_at - permit!.granted_at).toBe(30_000);
    expect(permit!.state).toBe("released");
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  } finally {
    try {
      writer.error(new Error("test_done"));
    } catch {
      /* already closed */
    }
    await pending;
  }
}, 60_000);

async function lockParent(f: Awaited<ReturnType<typeof fixture>>) {
  await env.DB.prepare(
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at,display_href) VALUES(?,?,?,?,?,'0','',1,?,'/dav/')",
  )
    .bind(
      crypto.randomUUID(),
      f.ids.folder,
      f.ids.space,
      f.input.principal.credential_id,
      crypto.randomUUID(),
      Date.now() + 60000,
    )
    .run();
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM locks WHERE node_id=?")
      .bind(f.ids.folder)
      .first("n"),
  ).toBe(1);
}

it.each(["credential", "owner", "parent", "epoch", "receipt", "lock", "unavailable"] as const)(
  "rechecks %s after waiting for pre-body owner admission",
  async (change) => {
    const f = await fixture();
    let puts = 0;
    const control = {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: async (request: MutationRequest) => {
          if (change === "unavailable") throw new Error("full");
          const grant = await acquireMutation(request);
          if (change === "credential")
            await env.DB.prepare(
              "UPDATE app_passwords SET revoked_at=1 WHERE id=(SELECT app_password_id FROM credentials WHERE id=?)",
            )
              .bind(f.input.principal.credential_id)
              .run();
          if (change === "owner")
            await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
              .bind(f.ids.user)
              .run();
          if (change === "parent")
            await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
              .bind(f.ids.folder)
              .run();
          if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
          if (change === "lock") await lockParent(f);
          if (change === "receipt")
            await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
              .bind(grant.id)
              .run();
          return grant;
        },
      }),
    } as unknown as Env["CONTROL"];
    await expect(
      f.run({
        CONTROL: control,
        BLOBS: davBucket({
          put: async () => {
            puts++;
            throw new Error("unexpected_put");
          },
        }),
      }),
    ).rejects.toThrow();
    expect(puts).toBe(0);
    expect(await f.op()).toBeNull();
    expect(await f.row()).toBeNull();
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
  },
);

it.each(["credential", "owner", "parent", "revision", "lock"] as const)(
  "keeps completed bytes held when %s changes during the body",
  async (change) => {
    const f = await fixture();
    const bucket = davBucket({
      put: async (k, b, o) => {
        const object = await env.BLOBS.put(k, b, o);
        expect(await f.op()).toBeNull();
        if (change === "lock") await lockParent(f);
        if (change === "credential")
          await env.DB.prepare(
            "UPDATE app_passwords SET revoked_at=1 WHERE id=(SELECT app_password_id FROM credentials WHERE id=?)",
          )
            .bind(f.input.principal.credential_id)
            .run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
        if (change === "parent" || change === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
            .bind(change === "parent" ? f.ids.folder : f.ids.file)
            .run();
        return object;
      },
    });
    await expect(
      putFile(
        { ...f.app, BLOBS: bucket },
        {
          ...f.input,
          ...(change === "revision"
            ? { nodeId: f.ids.file, name: "File", expectedRevision: 1 }
            : {}),
          body: new Blob(["abc"]).stream(),
        },
      ),
    ).rejects.toThrow();
    expect(await f.row()).toMatchObject({
      state: "completing",
      completion_op_id: null,
      in_flight: 0,
    });
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
    expect(
      await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
        .bind(f.ids.file)
        .first("current_blob_id"),
    ).toBe(f.ids.blob);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM operation_steps WHERE op_id=?")
        .bind((await f.row())!.id.slice(4))
        .first("n"),
    ).toBe(0);
  },
);

it("rejects a changed request digest before repeating an unclaimed native write", async () => {
  const f = await fixture();
  await expect(
    f.run({
      BLOBS: davBucket({
        put: async (k, b, o) => {
          await env.BLOBS.put(k, b, o);
          throw new Error("ack_lost");
        },
      }),
    }),
  ).rejects.toThrow("ack_lost");
  await expect(
    putFile(f.app, { ...f.input, name: "changed.txt", body: new Blob(["abc"]).stream() }),
  ).rejects.toThrow("idempotency_conflict");
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await f.op()).toBeNull();
});

it("refuses a stale HTTP target revision before starting any native write", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE nodes SET revision=2 WHERE id=?").bind(f.ids.file).run();
  await expect(
    putFile(f.app, {
      ...f.input,
      nodeId: f.ids.file,
      name: "File",
      expectedRevision: 1,
      body: new Blob(["abc"]).stream(),
    }),
  ).rejects.toThrow("dav_precondition_failed");
  expect(await f.row()).toBeNull();
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
});

it("holds saved bytes after a lost publication permit reply and never reacquires on replay", async () => {
  const f = await fixture();
  let requests = 0;
  const locks = {
    idFromName: f.app.LOCKS.idFromName.bind(f.app.LOCKS),
    get: (id: DurableObjectId) => ({
      acquireCreate: async (
        request: Parameters<ReturnType<Env["LOCKS"]["get"]>["acquireCreate"]>[0],
      ) => {
        requests++;
        await f.app.LOCKS.get(id).acquireCreate(request);
        throw new Error("permit_reply_lost");
      },
    }),
  } as unknown as Env["LOCKS"];
  await expect(f.run({ LOCKS: locks })).rejects.toThrow("permit_reply_lost");
  expect(await f.row()).toMatchObject({ state: "completing", completion_op_id: null });
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await f.op()).toBeNull();
  expect(await f.run({ LOCKS: locks })).toMatchObject({ kind: "commit_unknown" });
  expect(requests).toBe(1);
});

it.each(
  (["absent", "claimed"] as const).flatMap((publication) =>
    [false, true].map((present) => ({ publication, present })),
  ),
)(
  "cleans expired DAV body with publication=$publication, object=$present",
  async ({ publication, present }) => {
    const f = await history({ publication, present });
    expect(f.row.completion_op_id).toBeNull();
    const result = await repairSingleUploads(mutationEnv(), env.BLOBS, 1);
    expect(result).toMatchObject({
      claimed: 1,
      absent: present ? 0 : 1,
      queued: present ? 1 : 0,
      retried: 0,
    });
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: present ? 3 : 0 });
    expect(
      await env.DB.prepare("SELECT state FROM operations WHERE op_id=?")
        .bind(f.operationId)
        .first("state"),
    ).toBe(publication === "claimed" ? "failed" : null);
  },
);

it.each(["committed", "step"] as const)(
  "holds an unlinked DAV operation with %s evidence",
  async (evidence) => {
    const f = await history({
      publication: "claimed",
      present: true,
      operationState: evidence === "committed" ? "committed" : "claimed",
    });
    if (evidence === "step")
      await env.DB.prepare(
        "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      )
        .bind(f.operationId, f.ids.file)
        .run();
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
      claimed: 0,
      r2Calls: 0,
    });
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  },
);

it("blocks a late publication claim after cleanup tombstones its previously unclaimed body", async () => {
  const f = await history({ publication: "absent", state: "completing", present: true });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 1,
    queued: 1,
  });
  const principal = f.input.principal;
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.create",
    parentId: f.ids.folder,
    spaceId: f.ids.space,
  });
  const intent: OperationIntent = {
    id: f.operationId,
    principal,
    principalId: f.ids.user,
    spaceId: f.ids.space,
    kind: "dav.put",
    digest: f.row.request_digest,
    operands: JSON.stringify({ parentId: f.ids.folder }),
  };
  const permit = await f.app.LOCKS.get(f.app.LOCKS.idFromName(f.ids.space)).acquireCreate({
    requestId: intent.id,
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    principal,
    lockTokens: [],
  });
  expect(await claimOperation(env.DB, intent, permit, authorized, 10)).toMatchObject({
    kind: "claimed",
  });
  await expect(
    atomicBatch(
      env.DB,
      davPublicationStatements(f.row, { object: f.object!, sha256: "a".repeat(64) }),
    ),
  ).rejects.toThrow();
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT state,completion_op_id FROM uploads WHERE id=?")
      .bind(f.id)
      .first(),
  ).toEqual({ state: "failed", completion_op_id: null });
});
