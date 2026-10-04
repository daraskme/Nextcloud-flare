import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleDavHttp } from "../../src/api/dav";
import { appPasswordPepperRing, hashAppPassword } from "../../src/auth/appPassword";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { evaluateDavMutationConditions } from "../../src/dav/conditionState";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function admittedDavEnv(): Env {
  const app = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit() {
        return { success: true };
      },
    } as RateLimit,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    ...app,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const invoke = async <T>(callback: (lock: LockDO) => Promise<T>) => {
          const result = await runInDurableObject(env.LOCKS.get(id), async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, app)) };
            } catch (error) {
              return { ok: false as const, message: (error as Error).message };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireTrash: (r: Parameters<LockDO["acquireTrash"]>[0]) =>
            invoke((l) => l.acquireTrash(r)),
          acquireMove: (r: Parameters<LockDO["acquireMove"]>[0]) => invoke((l) => l.acquireMove(r)),
          acquireCopy: (r: Parameters<LockDO["acquireCopy"]>[0]) => invoke((l) => l.acquireCopy(r)),
          createDavLock: (r: Parameters<LockDO["createDavLock"]>[0]) =>
            invoke((l) => l.createDavLock(r)),
          release: (id: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((l) => l.release(id, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `ap_${Array.from(
    crypto.getRandomValues(new Uint8Array(26)),
    (value) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[value % 32],
  ).join("")}`;
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const pepper = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await appPasswordPepperRing("v1", { v1: pepper }, localKdf);
  const record = await hashAppPassword(secret, ring);
  const search = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
        VALUES(?,?,?,'DAV',?,?,?,?,?,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.folder,
        record.secretDigest,
        record.salt,
        record.kdf,
        record.kdfParams,
        record.kid,
        Date.now() - 1000,
        Date.now() + 600000,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [`ap:${id}`, id],
    },
    ...["node:read", "node:delete", "node:write", "node:create"].map((scope) => ({
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,?)",
      values: [`ap:${id}`, scope],
    })),
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.file, f.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const app = admittedDavEnv();
  const principal: Principal = {
    kind: "app_password",
    credential_id: `ap:${id}`,
    user_id: f.ids.user,
    epoch: 1,
  };
  const request = (
    method: string,
    headers: Record<string, string> = {},
    db = env.DB,
    source = "File",
  ) =>
    handleDavHttp(
      new Request(`https://app.invalid/dav/${source}`, {
        method,
        headers: {
          Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
          ...(method === "DELETE"
            ? {}
            : { Destination: "https://app.invalid/dav/NewFile", Overwrite: "F" }),
          ...headers,
        },
      }),
      { ...app, DB: db },
      1,
      ring,
    );
  const etag = `"b-${f.ids.blob}"`;
  const snapshot = async () => {
    const results = await atomicBatch(env.DB, [
      { sql: "SELECT * FROM nodes WHERE space_id=? ORDER BY id", values: [f.ids.space] },
      { sql: "SELECT * FROM spaces WHERE id=?", values: [f.ids.space] },
      { sql: "SELECT * FROM blobs WHERE owner_id=? ORDER BY id", values: [f.ids.user] },
      {
        sql: "SELECT * FROM search_index WHERE space_id=? ORDER BY node_id",
        values: [f.ids.space],
      },
      { sql: "SELECT * FROM trash_ops WHERE space_id=?", values: [f.ids.space] },
      { sql: "SELECT * FROM shares WHERE owner_id=? ORDER BY id", values: [f.ids.user] },
      { sql: "SELECT * FROM activity WHERE actor_id=?", values: [f.ids.user] },
      {
        sql: "SELECT * FROM outbox WHERE op_id IN (SELECT op_id FROM operations WHERE space_id=?)",
        values: [f.ids.space],
      },
    ]);
    return results.map((result) => result.results);
  };
  const changeSource = async () => {
    const replacement = `${f.ids.blob}-replacement`;
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',?)",
        values: [
          replacement,
          f.ids.user,
          `u/${f.ids.user}/b/${replacement}`,
          `"b-${replacement}"`,
          Date.now(),
        ],
      },
      {
        sql: "UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?",
        values: [replacement, f.ids.file],
      },
    ]);
    return replacement;
  };
  return { ...f, id, principal, app, request, etag, snapshot, changeSource };
}

const methods = ["DELETE", "COPY", "MOVE"] as const;
it("a fabricated conditional object cannot bypass proof or service authorization", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  await expect(
    trashNode(f.app, {
      principal: f.principal,
      requestId: crypto.randomUUID(),
      nodeId: f.ids.file,
      spaceId: f.ids.space,
      lockTokens: [],
      conditions: { sourceNodeId: f.ids.file, spaceId: f.ids.space },
    }),
  ).rejects.toThrow("invalid_dav_condition_proof");
  expect(await f.snapshot()).toEqual(before);
});

it("a valid conditional object does not replace current service authorization", async () => {
  const f = await fixture();
  const authorized = await authorizeNode(env.DB, f.principal, {
    operation: "node.read",
    nodeId: f.ids.file,
    spaceId: f.ids.space,
  });
  if (authorized.operation !== "node.read") throw new Error("invalid_fixture");
  const { conditions } = await evaluateDavMutationConditions(
    env.DB,
    f.principal,
    "https://app.invalid",
    new Request("https://app.invalid/dav/File", { headers: { If: `([${f.etag}])` } }),
    authorized.node,
    f.principal,
  );
  await env.DB.prepare(
    "DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:delete'",
  )
    .bind(f.principal.credential_id)
    .run();
  const before = await f.snapshot();
  await expect(
    trashNode(f.app, {
      principal: f.principal,
      requestId: crypto.randomUUID(),
      nodeId: f.ids.file,
      spaceId: f.ids.space,
      lockTokens: [],
      conditions,
    }),
  ).rejects.toThrow("authorization_denied");
  expect(await f.snapshot()).toEqual(before);
});

for (const method of methods) {
  it(`${method} accepts successful DAV If with submitted lock tokens and matching ETag`, async () => {
    const f = await fixture();
    const lock = f.app.LOCKS.get(f.app.LOCKS.idFromName(f.ids.space));
    const created = await lock.createDavLock({
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      nodeId: f.ids.file,
      principal: f.principal,
      displayHref: "/dav/File",
      depth: "0",
      ownerText: "owner",
      timeoutSeconds: 120,
    });
    expect(
      (await f.request(method, { If: `(["old"]) (<${created.token}> [${f.etag}])` })).status,
    ).toBe(method === "DELETE" ? 204 : 201);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE space_id=? AND state='committed'",
      )
        .bind(f.ids.space)
        .first("n"),
    ).toBe(1);
  });

  if (method !== "COPY")
    it(`${method} rejects stale conditions without granting read scope to a write-only credential`, async () => {
      const f = await fixture();
      await env.DB.prepare(
        "DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:read'",
      )
        .bind(f.principal.credential_id)
        .run();
      const before = await f.snapshot();
      expect((await f.request(method, { "If-Match": '"b-stale"' })).status).toBe(412);
      expect(await f.snapshot()).toEqual(before);
    });

  it(`${method} binds revision even when the blob ETag does not change`, async () => {
    const f = await fixture();
    let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
          .bind(f.ids.file)
          .run();
        expected = await f.snapshot();
      },
      false,
    );
    expect((await f.request(method, { If: `([${f.etag}])` }, db)).status).toBe(412);
    expect(await f.snapshot()).toEqual(expected);
  });

  it(`${method} binds tagged-resource revisions through publication`, async () => {
    const f = await fixture();
    let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
          .bind(f.ids.folder)
          .run();
        expected = await f.snapshot();
      },
      false,
    );
    expect(
      (await f.request(method, { If: `<https://app.invalid/dav/> (["c-${f.ids.folder}-1"])` }, db))
        .status,
    ).toBe(412);
    expect(await f.snapshot()).toEqual(expected);
  });

  it(`${method} binds the absence of a tagged resource used by Not`, async () => {
    const f = await fixture();
    let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,'Missing','missing','folder',?,?)`)
          .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder, Date.now(), Date.now())
          .run();
        expected = await f.snapshot();
      },
      false,
    );
    expect(
      (await f.request(method, { If: '<https://app.invalid/dav/Missing> (Not ["absent"])' }, db))
        .status,
    ).toBe(412);
    expect(await f.snapshot()).toEqual(expected);
  });

  it(`${method} retains DAV lock-token submission while binding lock expiry changes`, async () => {
    const f = await fixture();
    const lock = f.app.LOCKS.get(f.app.LOCKS.idFromName(f.ids.space));
    const created = await lock.createDavLock({
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      nodeId: f.ids.file,
      principal: f.principal,
      displayHref: "/dav/File",
      depth: "0",
      ownerText: "owner",
      timeoutSeconds: 120,
    });
    let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await env.DB.prepare("UPDATE locks SET expires_at=expires_at+1000 WHERE node_id=?")
          .bind(f.ids.file)
          .run();
        expected = await f.snapshot();
      },
      false,
    );
    expect((await f.request(method, { If: `(<${created.token}> [${f.etag}])` }, db)).status).toBe(
      412,
    );
    expect(await f.snapshot()).toEqual(expected);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM locks WHERE node_id=?")
        .bind(f.ids.file)
        .first("n"),
    ).toBe(1);
  });

  it(`${method} still checks credential revocation at publication`, async () => {
    const f = await fixture();
    let expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.id)
          .run();
        expected = await f.snapshot();
      },
      false,
    );
    expect((await f.request(method, { If: `([${f.etag}])` }, db)).status).toBe(503);
    expect(await f.snapshot()).toEqual(expected);
  });

  it(`${method} never treats a transport failure as a definite conditional rejection`, async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        throw new Error("transport_unavailable");
      },
      false,
    );
    const response = await f.request(method, { If: `([${f.etag}])` }, db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Operation-Id")).toBeTruthy();
    expect(await f.snapshot()).toEqual(before);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM operations WHERE space_id=? AND state='failed'")
        .bind(f.ids.space)
        .first("n"),
    ).toBe(0);
  });

  it(`${method} reconciles a lost publication ACK without rechecking its own changed snapshot`, async () => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        throw new Error("lost_ack");
      },
      true,
    );
    expect((await f.request(method, { If: `([${f.etag}])` }, db)).status).toBe(
      method === "DELETE" ? 204 : 201,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM operations WHERE space_id=? AND state='committed'",
      )
        .bind(f.ids.space)
        .first("n"),
    ).toBe(1);
  });

  for (const validator of ["stale", "weak", "none-match", "date", "malformed"] as const) {
    it(`${method} rejects ${validator} HTTP validators without namespace effects`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      const headers =
        validator === "stale"
          ? { "If-Match": '"b-stale"' }
          : validator === "weak"
            ? { "If-Match": `W/${f.etag}` }
            : validator === "none-match"
              ? { "If-None-Match": `W/${f.etag}` }
              : validator === "date"
                ? { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" }
                : { "If-Match": '"unterminated' };
      expect((await f.request(method, headers)).status).toBe(validator === "malformed" ? 400 : 412);
      expect(await f.snapshot()).toEqual(before);
      expect(
        await env.DB.prepare("SELECT COUNT(*) n FROM permits WHERE space_id=?")
          .bind(f.ids.space)
          .first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare("SELECT COUNT(*) n FROM operations WHERE space_id=?")
          .bind(f.ids.space)
          .first("n"),
      ).toBe(0);
    });
  }

  for (const validator of ["list", "wildcard", "date", "ignored-date"] as const) {
    it(`${method} accepts ${validator} HTTP validators on the source URI`, async () => {
      const f = await fixture();
      const headers =
        validator === "list"
          ? {
              "If-Match": `"b-stale", W/${f.etag}, ${f.etag}`,
              "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
            }
          : validator === "wildcard"
            ? { "If-Match": "*" }
            : validator === "date"
              ? { "If-Unmodified-Since": new Date().toUTCString() }
              : {
                  "If-Unmodified-Since": "not a date",
                  "If-Modified-Since": new Date().toUTCString(),
                };
      expect((await f.request(method, headers)).status).toBe(method === "DELETE" ? 204 : 201);
    });
  }

  for (const phase of ["evaluation", "publication"] as const) {
    for (const validator of ["If", "If-Match"] as const) {
      it(`${method} returns 412 if source changes after ${validator} at ${phase}, with no namespace publication`, async () => {
        const f = await fixture();
        let changed = false,
          expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
        const db = injectBatch(
          (sql) =>
            phase === "evaluation"
              ? sql.includes("SELECT json_group_array(json_object")
              : sql.includes("UPDATE operations SET state='committed'"),
          async () => {
            await f.changeSource();
            changed = true;
            expected = await f.snapshot();
          },
          phase === "evaluation",
        );
        const response = await f.request(
          method,
          { [validator]: validator === "If" ? `([${f.etag}])` : f.etag },
          db,
        );
        expect(changed).toBe(true);
        expect(response.status).toBe(412);
        expect(await f.snapshot()).toEqual(expected);
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) n FROM operations WHERE space_id=? AND state='committed'",
          )
            .bind(f.ids.space)
            .first("n"),
        ).toBe(0);
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) n FROM operation_steps WHERE op_id IN (SELECT op_id FROM operations WHERE space_id=?)",
          )
            .bind(f.ids.space)
            .first("n"),
        ).toBe(0);
      });
    }
  }
}
