import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleDavHttp } from "../../src/api/dav";
import {
  appPasswordPepperRing,
  authenticateAppPassword,
  hashAppPassword,
} from "../../src/auth/appPassword";
import { lockTokenHashes } from "../../src/auth/locks";
import { parseDavPath, resolveDavNode } from "../../src/dav/path";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { acquireMutation, grantPermit } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

const emptyBody = () =>
  new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

function admittedDavEnv(overloaded = false): Env {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: overloaded
          ? async () => {
              throw new Error("queue_full");
            }
          : acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit() {
        return { success: true };
      },
    } as RateLimit,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const stub = env.LOCKS.get(id);
        const invoke = async <T>(callback: (instance: LockDO) => Promise<T>): Promise<T> => {
          const result = await runInDurableObject(stub, async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_error",
              };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireCreate: (request: Parameters<LockDO["acquireCreate"]>[0]) =>
            invoke((lock) => lock.acquireCreate(request)),
          acquireNodeWrite: (request: Parameters<LockDO["acquireNodeWrite"]>[0]) =>
            invoke((lock) => lock.acquireNodeWrite(request)),
          acquireTrash: (request: Parameters<LockDO["acquireTrash"]>[0]) =>
            invoke((lock) => lock.acquireTrash(request)),
          acquireMove: (request: Parameters<LockDO["acquireMove"]>[0]) =>
            invoke((lock) => lock.acquireMove(request)),
          acquireCopy: (request: Parameters<LockDO["acquireCopy"]>[0]) =>
            invoke((lock) => lock.acquireCopy(request)),
          createDavLock: (request: Parameters<LockDO["createDavLock"]>[0]) =>
            invoke((lock) => lock.createDavLock(request)),
          refreshDavLock: (request: Parameters<LockDO["refreshDavLock"]>[0]) =>
            invoke((lock) => lock.refreshDavLock(request)),
          unlockDavLock: (request: Parameters<LockDO["unlockDavLock"]>[0]) =>
            invoke((lock) => lock.unlockDavLock(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

async function fixture(suffix: string) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `ap_${"0".repeat(25)}${suffix}`;
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const pepper = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await appPasswordPepperRing("v1", { v1: pepper }, localKdf);
  const record = await hashAppPassword(secret, ring);
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
  ]);
  const request = (password = secret, headers: Record<string, string> = {}) =>
    new Request("https://app.invalid/dav/file", {
      headers: { Authorization: `Basic ${btoa(`${id}:${password}`)}`, ...headers },
    });
  return { f, id, secret, pepper, ring, request };
}

it("authenticates a live DAV Basic app password and rejects a wrong secret", async () => {
  const { f, id, secret, ring, request } = await fixture("1");
  expect(await authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, ring)).toEqual({
    kind: "app_password",
    user_id: f.ids.user,
    credential_id: `ap:${id}`,
    epoch: 1,
  });
  const wrong = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  expect(wrong).not.toBe(secret);
  await expect(
    authenticateAppPassword(env.DB, request(wrong), "https://app.invalid", 1, ring),
  ).rejects.toThrow("app_password_denied");
  await expect(
    authenticateAppPassword(
      env.DB,
      request(secret, { Origin: "https://app.invalid" }),
      "https://app.invalid",
      1,
      ring,
    ),
  ).rejects.toThrow("app_password_denied");
  await expect(
    authenticateAppPassword(
      env.DB,
      request(secret, { "Cf-Access-Jwt-Assertion": "wrong-profile" }),
      "https://app.invalid",
      1,
      ring,
    ),
  ).rejects.toThrow("app_password_denied");
});

it("rejects maintenance, old epoch, revoked records and unknown pepper kids", async () => {
  const { id, ring, request } = await fixture("2");
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 2, ring),
  ).rejects.toThrow("app_password_denied");
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, ring),
  ).rejects.toThrow("app_password_denied");
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  const other = await appPasswordPepperRing(
    "v2",
    {
      v2: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    },
    localKdf,
  );
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, other),
  ).rejects.toThrow("app_password_denied");
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
    .bind(Date.now(), id)
    .run();
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, ring),
  ).rejects.toThrow("app_password_denied");
});

it("rechecks revocation after the password KDF completes", async () => {
  const { id, ring, request } = await fixture("3");
  const db = {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT 1 FROM app_passwords ap")) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async first() {
              await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
                .bind(Date.now(), id)
                .run();
              return bound.first();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  await expect(
    authenticateAppPassword(db, request(), "https://app.invalid", 1, ring),
  ).rejects.toThrow("app_password_denied");
});

it("rotates an old pepper kid after successful authentication", async () => {
  const { id, pepper, request } = await fixture("4");
  const next = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await appPasswordPepperRing("v2", { v1: pepper, v2: next }, localKdf);
  const before = await env.DB.prepare("SELECT secret_digest,salt FROM app_passwords WHERE id=?")
    .bind(id)
    .first<{ secret_digest: string; salt: string }>();
  await authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, ring);
  const after = await env.DB.prepare("SELECT secret_digest,salt,kid FROM app_passwords WHERE id=?")
    .bind(id)
    .first<{ secret_digest: string; salt: string; kid: string }>();
  expect(after?.kid).toBe("v2");
  expect(after?.secret_digest).not.toBe(before?.secret_digest);
  expect(after?.salt).not.toBe(before?.salt);
  const currentOnly = await appPasswordPepperRing("v2", { v2: next }, localKdf);
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, currentOnly),
  ).resolves.toMatchObject({ kind: "app_password" });
});

it("accepts a committed rotation when the D1 acknowledgement is lost", async () => {
  const { id, pepper, request } = await fixture("5");
  const ring = await appPasswordPepperRing(
    "v2",
    {
      v1: pepper,
      v2: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    },
    localKdf,
  );
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.batch(statements);
      throw new Error("d1_ack_lost");
    },
  } as unknown as D1Database;
  await expect(
    authenticateAppPassword(db, request(), "https://app.invalid", 1, ring),
  ).resolves.toMatchObject({ kind: "app_password" });
  expect(
    await env.DB.prepare("SELECT kid FROM app_passwords WHERE id=?")
      .bind(id)
      .first<{ kid: string }>(),
  ).toEqual({ kid: "v2" });
});

it("limits DAV requests before Basic verification and keeps unavailable operations closed", async () => {
  const { id, ring, request } = await fixture("6");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  let allowed = false;
  const keys: string[] = [];
  const davEnv = {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: allowed };
      },
    },
  } as unknown as Env;
  const limited = await handleDavHttp(request(), davEnv, 1, ring);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  expect(keys).toEqual(["dav:unknown"]);

  allowed = true;
  const wrong = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const denied = await handleDavHttp(request(wrong), davEnv, 1, ring);
  expect(denied.status).toBe(401);
  expect(denied.headers.get("WWW-Authenticate")).toContain("Basic");
  expect((await handleDavHttp(request(), davEnv, 1, ring)).status).toBe(503);
  expect(
    (await handleDavHttp(request(undefined, { "CF-Connecting-IP": "192.0.2.10" }), davEnv, 1, ring))
      .status,
  ).toBe(503);
  expect(keys.at(-1)).toBe("dav:192.0.2.10");
  const optionsRequest = new Request(request().url, {
    method: "OPTIONS",
    headers: request().headers,
  });
  const options = await handleDavHttp(optionsRequest, davEnv, 1, ring);
  expect(options.status).toBe(200);
  expect(options.headers.get("DAV")).toBe("1");
  expect(options.headers.get("Allow")).toBe(
    "OPTIONS, GET, HEAD, PUT, DELETE, COPY, MOVE, PROPFIND, PROPPATCH, MKCOL, LOCK, UNLOCK",
  );
  expect((await handleDavHttp(request(), davEnv, 1, undefined)).status).toBe(503);
  expect((await handleDavHttp(new Request("http://app.invalid/dav"), davEnv, 1, ring)).status).toBe(
    404,
  );
});

it("streams authorized DAV GET, HEAD and Range reads from an immutable blob", async () => {
  const { f, id, ring, request } = await fixture("9");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  const stored = await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc");
  if (!stored) throw new Error("fixture_r2_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, stored.etag, Date.now())
    .run();
  const davEnv = {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  } as unknown as Env;
  try {
    const full = await handleDavHttp(request(), davEnv, 1, ring);
    expect(full.status).toBe(200);
    expect(new TextDecoder().decode(await full.arrayBuffer())).toBe("abc");
    expect(full.headers.get("ETag")).toBe(`"b-${f.ids.blob}"`);

    const ranged = await handleDavHttp(
      new Request(request().url, {
        headers: { ...Object.fromEntries(request().headers), Range: "bytes=1-2" },
      }),
      davEnv,
      1,
      ring,
    );
    expect(ranged.status).toBe(206);
    expect(new TextDecoder().decode(await ranged.arrayBuffer())).toBe("bc");
    const head = await handleDavHttp(
      new Request(request().url, { method: "HEAD", headers: request().headers }),
      davEnv,
      1,
      ring,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("Content-Length")).toBe("3");
    expect(
      (
        await handleDavHttp(
          new Request(`${request().url}/`, { headers: request().headers }),
          davEnv,
          1,
          ring,
        )
      ).status,
    ).toBe(404);
    await env.BLOBS.delete(`u/${f.ids.user}/b/${f.ids.blob}`);
    expect((await handleDavHttp(request(), davEnv, 1, ring)).status).toBe(503);
  } finally {
    await env.BLOBS.delete(`u/${f.ids.user}/b/${f.ids.blob}`);
  }
});

it("returns bounded DAV PROPFIND Depth 0 and 1 multistatus responses", async () => {
  const { f, id, ring, request } = await fixture("A");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,'urn:ncf:props','color','blue')",
  )
    .bind(f.ids.file)
    .run();
  const davEnv = {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  } as unknown as Env;
  const depthZero = await handleDavHttp(
    new Request(request().url, {
      method: "PROPFIND",
      headers: { ...Object.fromEntries(request().headers), Depth: "0" },
    }),
    davEnv,
    1,
    ring,
  );
  expect(depthZero.status).toBe(207);
  const zeroXml = await depthZero.text();
  expect(zeroXml).toContain("<D:href>/dav/File</D:href>");
  expect(zeroXml).toContain(`<D:getetag>&quot;b-${f.ids.blob}&quot;</D:getetag>`);
  expect(zeroXml).toContain(
    "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>",
  );
  expect(zeroXml).toContain('<N:color xmlns:N="urn:ncf:props">blue</N:color>');

  const body =
    '<D:propfind xmlns:D="DAV:" xmlns:X="urn:ncf:props"><D:prop><D:displayname/><X:color/><X:missing/></D:prop></D:propfind>';
  const depthOne = await handleDavHttp(
    new Request("https://app.invalid/dav", {
      method: "PROPFIND",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        Depth: "1",
      },
      body,
    }),
    davEnv,
    1,
    ring,
  );
  expect(depthOne.status).toBe(207);
  const oneXml = await depthOne.text();
  expect(oneXml.match(/<D:response>/g)).toHaveLength(2);
  expect(oneXml).toContain("<D:href>/dav/</D:href>");
  expect(oneXml).toContain("<D:href>/dav/File</D:href>");
  expect(oneXml).toContain("HTTP/1.1 404 Not Found");
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav", {
          method: "PROPFIND",
          headers: request().headers,
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(403);
});

it("rejects DAV Depth 1 before reading more than 1,000 children", async () => {
  const { f, id, ring, request } = await fixture("B");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  await env.DB.prepare(`WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<1000)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    SELECT ?||x,?,?,?,'n'||x,'n'||printf('%04d',x),'folder',?,? FROM seq`)
    .bind(
      `child-${crypto.randomUUID()}-`,
      f.ids.space,
      f.ids.user,
      f.ids.folder,
      Date.now(),
      Date.now(),
    )
    .run();
  const response = await handleDavHttp(
    new Request("https://app.invalid/dav", {
      method: "PROPFIND",
      headers: { ...Object.fromEntries(request().headers), Depth: "1" },
    }),
    {
      DB: env.DB,
      BLOBS: env.BLOBS,
      APP_ORIGIN: "https://app.invalid",
      EDGE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
    } as unknown as Env,
    1,
    ring,
  );
  expect(response.status).toBe(507);
});

it("creates a DAV collection through the fenced namespace mutation service", async () => {
  const { f, id, ring, request } = await fixture("C");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:create')")
    .bind(`ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const key = crypto.randomUUID();
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav", {
          method: "OPTIONS",
          headers: request().headers,
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(200);
  const send = (
    url = "https://app.invalid/dav/New%20Folder",
    idempotencyKey = key,
    body?: string | ReadableStream<Uint8Array>,
  ) =>
    handleDavHttp(
      new Request(
        url,
        body === undefined
          ? {
              method: "MKCOL",
              headers: {
                ...Object.fromEntries(request().headers),
                "Idempotency-Key": idempotencyKey,
              },
            }
          : {
              method: "MKCOL",
              headers: {
                ...Object.fromEntries(request().headers),
                "Idempotency-Key": idempotencyKey,
              },
              body,
            },
      ),
      davEnv,
      1,
      ring,
    );
  const created = await send(undefined, undefined, emptyBody());
  expect(created.status).toBe(201);
  expect(created.headers.get("Location")).toBe("/dav/New%20Folder/");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE parent_id=? AND name='New Folder'",
    )
      .bind(f.ids.folder)
      .first<number>("count"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT kind FROM operations WHERE credential_id=? ORDER BY updated_at DESC",
    )
      .bind(`ap:${id}`)
      .first<string>("kind"),
  ).toBe("dav.mkcol");
  expect((await send()).status).toBe(201);
  expect((await send("https://app.invalid/dav/Different")).status).toBe(409);
  expect((await send("https://app.invalid/dav/New%20Folder", crypto.randomUUID())).status).toBe(
    405,
  );
  expect((await send("https://app.invalid/dav/Body", crypto.randomUUID(), "x")).status).toBe(415);
  const noKey = await handleDavHttp(
    new Request("https://app.invalid/dav/NoKey", {
      method: "MKCOL",
      headers: request().headers,
    }),
    davEnv,
    1,
    ring,
  );
  expect(noKey.status).toBe(400);

  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const [tokenHash] = await lockTokenHashes([token]);
  await env.DB.prepare(
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'/dav/','0','owner',1,?)",
  )
    .bind(
      `lock-${crypto.randomUUID()}`,
      f.ids.folder,
      f.ids.space,
      `ap:${id}`,
      tokenHash,
      Date.now() + 60_000,
    )
    .run();
  const locked = await handleDavHttp(
    new Request("https://app.invalid/dav/Locked", {
      method: "MKCOL",
      headers: {
        ...Object.fromEntries(request().headers),
        "Idempotency-Key": crypto.randomUUID(),
        If: `<https://app.invalid/dav/> (<${token}>)`,
      },
    }),
    davEnv,
    1,
    ring,
  );
  expect(locked.status).toBe(201);
  const failedCondition = await handleDavHttp(
    new Request("https://app.invalid/dav/Locked2", {
      method: "MKCOL",
      headers: {
        ...Object.fromEntries(request().headers),
        "Idempotency-Key": crypto.randomUUID(),
        If: "<https://app.invalid/dav/> (<opaquelocktoken:wrong>)",
      },
    }),
    davEnv,
    1,
    ring,
  );
  expect(failedCondition.status).toBe(412);
});

it.each(["revoked", "maintenance"])(
  "rechecks authority after waiting for the empty request body (%s)",
  async (reason) => {
    const { f, id, ring, request } = await fixture(reason === "revoked" ? "Z" : "Y");
    await env.DB.prepare(
      "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:create')",
    )
      .bind(`ap:${id}`)
      .run();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulled = true;
          if (reason === "revoked")
            await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
              .bind(Date.now(), id)
              .run();
          else await env.DB.prepare("UPDATE control SET maintenance=1").run();
          controller.close();
        },
      },
      { highWaterMark: 0 }, // Revocation happens when the authenticated handler reads the body.
    );
    const response = await handleDavHttp(
      new Request("https://app.invalid/dav/After-wait", {
        method: "MKCOL",
        headers: {
          ...Object.fromEntries(request().headers),
          "Idempotency-Key": crypto.randomUUID(),
        },
        body,
      }),
      admittedDavEnv(),
      1,
      ring,
    );
    expect(pulled).toBe(true);
    expect(response.status).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='After-wait'",
      )
        .bind(f.ids.folder)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE credential_id=?")
        .bind(`ap:${id}`)
        .first("n"),
    ).toBe(0);
  },
);

it("atomically writes DAV dead properties and rejects protected live properties", async () => {
  const { f, id, ring, request } = await fixture("D");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:write')")
    .bind(`ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const key = crypto.randomUUID();
  const body = `<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test">
    <D:set><D:prop><X:color>blue &amp; green<X:shade level="2">dark</X:shade></X:color></D:prop></D:set>
    <D:remove><D:prop><X:missing/></D:prop></D:remove>
  </D:propertyupdate>`;
  const send = (xml: string, idempotencyKey = key) =>
    handleDavHttp(
      new Request("https://app.invalid/dav/File", {
        method: "PROPPATCH",
        headers: {
          ...Object.fromEntries(request().headers),
          "Content-Type": "application/xml",
          "Idempotency-Key": idempotencyKey,
        },
        body: xml,
      }),
      davEnv,
      1,
      ring,
    );
  const changed = await send(body);
  expect(changed.status).toBe(207);
  expect(await changed.text()).toContain("HTTP/1.1 200 OK");
  const property = await env.DB.prepare(
    "SELECT value_xml AS value FROM node_props WHERE node_id=? AND namespace='urn:test' AND name='color'",
  )
    .bind(f.ids.file)
    .first<string>("value");
  expect(property).toContain("blue &amp; green");
  expect(property).toContain("dark");
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(f.ids.file)
      .first<number>("revision"),
  ).toBe(2);
  expect((await send(body)).status).toBe(207);
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(f.ids.file)
      .first<number>("revision"),
  ).toBe(2);

  const protectedBody = `<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop>
    <X:untouched>no</X:untouched><D:getetag>bad</D:getetag><X:later>no</X:later>
  </D:prop></D:set></D:propertyupdate>`;
  const rejected = await send(protectedBody, crypto.randomUUID());
  expect(rejected.status).toBe(207);
  const rejectedXml = await rejected.text();
  expect(rejectedXml).toContain("HTTP/1.1 403 Forbidden");
  expect(rejectedXml.match(/HTTP\/1.1 424 Failed Dependency/g)).toHaveLength(2);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM node_props WHERE node_id=? AND namespace='urn:test' AND name IN ('untouched','later')",
    )
      .bind(f.ids.file)
      .first<number>("count"),
  ).toBe(0);

  const etagBody =
    '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:etag-match>yes</X:etag-match></D:prop></D:set></D:propertyupdate>';
  const etagMatched = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPPATCH",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        "Idempotency-Key": crypto.randomUUID(),
        If: `(["b-${f.ids.blob}"])`,
      },
      body: etagBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(etagMatched.status).toBe(207);
  const etagStale = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPPATCH",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        "Idempotency-Key": crypto.randomUUID(),
        If: '(["b-stale"])',
      },
      body: etagBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(etagStale.status).toBe(412);

  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const [tokenHash] = await lockTokenHashes([token]);
  await env.DB.prepare(
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'/dav/File','0','owner',1,?)",
  )
    .bind(
      `lock-${crypto.randomUUID()}`,
      f.ids.file,
      f.ids.space,
      `ap:${id}`,
      tokenHash,
      Date.now() + 60_000,
    )
    .run();
  const lockedBody =
    '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:locked>yes</X:locked></D:prop></D:set></D:propertyupdate>';
  const missingSubmission = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPPATCH",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        "Idempotency-Key": crypto.randomUUID(),
        If: "(Not <DAV:no-lock>)",
      },
      body: lockedBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(missingSubmission.status).toBe(423);
  const locked = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPPATCH",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        "Idempotency-Key": crypto.randomUUID(),
        If: `(<${token}>)`,
      },
      body: lockedBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(locked.status).toBe(207);
  expect(
    await env.DB.prepare(
      "SELECT value_xml AS value FROM node_props WHERE node_id=? AND namespace='urn:test' AND name='locked'",
    )
      .bind(f.ids.file)
      .first<string>("value"),
  ).toBe("yes");
  const stale = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPPATCH",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        "Idempotency-Key": crypto.randomUUID(),
        If: "(<opaquelocktoken:wrong>)",
      },
      body: lockedBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(stale.status).toBe(412);
});

it("returns retryable 503 for overloaded DAV lock creation, refresh and unlock", async () => {
  const { f, id, ring, request } = await fixture("N");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:write')")
    .bind(`ap:${id}`)
    .run();
  const headers = Object.fromEntries(request().headers);
  const body =
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
  const create = () =>
    new Request("https://app.invalid/dav/File", {
      method: "LOCK",
      headers: { ...headers, "Content-Type": "application/xml", Depth: "0" },
      body,
    });
  const rejected = await handleDavHttp(create(), admittedDavEnv(true), 1, ring);
  expect(rejected.status).toBe(503);
  expect(rejected.headers.get("Retry-After")).toBe("1");
  const locks = () =>
    env.DB.prepare("SELECT id,token_hash,expires_at FROM locks WHERE space_id=?")
      .bind(f.ids.space)
      .all();
  expect((await locks()).results).toEqual([]);
  const created = await handleDavHttp(create(), admittedDavEnv(), 1, ring);
  expect(created.status).toBe(200);
  const lockToken = created.headers.get("Lock-Token")!;
  const before = (await locks()).results;
  for (const method of ["LOCK", "UNLOCK"]) {
    const response = await handleDavHttp(
      new Request("https://app.invalid/dav/File", {
        method,
        headers: {
          ...headers,
          ...(method === "LOCK"
            ? { If: `(${lockToken})`, Timeout: "Second-120" }
            : { "Lock-Token": lockToken }),
        },
        body: emptyBody(),
      }),
      admittedDavEnv(true),
      1,
      ring,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect((await locks()).results).toEqual(before);
  }
});

it("creates, refreshes and removes an existing-resource DAV lock", async () => {
  const { f, id, ring, request } = await fixture("E");
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:write'),(?,'node:read')",
  )
    .bind(`ap:${id}`, `ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const body = `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>
    <D:locktype><D:write/></D:locktype><D:owner>Alice &amp; Bob</D:owner></D:lockinfo>`;
  const createLock = () =>
    handleDavHttp(
      new Request("https://app.invalid/dav/File", {
        method: "LOCK",
        headers: {
          ...Object.fromEntries(request().headers),
          "Content-Type": "application/xml",
          Depth: "0",
          Timeout: "Second-90",
        },
        body,
      }),
      davEnv,
      1,
      ring,
    );
  const lockStub = davEnv.LOCKS.get(davEnv.LOCKS.idFromName(f.ids.space));
  const initializeRequest = {
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.file,
    principal: {
      kind: "app_password" as const,
      user_id: f.ids.user,
      credential_id: `ap:${id}`,
      epoch: 1,
    },
    lockTokens: [],
  };
  const initializePermit = await lockStub.acquireNodeWrite(initializeRequest);
  await lockStub.release(initializeRequest.requestId, initializePermit);
  const permitId = crypto.randomUUID();
  await grantPermit(env.DB, permitId, f.ids.space, 1);
  expect((await createLock()).status).toBe(423);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permitId)
    .run();
  const expiredPermitId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO permits VALUES(?,?,1,?,'open')")
    .bind(expiredPermitId, f.ids.space, Date.now() - 2_000)
    .run();
  const created = await createLock();
  expect(created.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(expiredPermitId)
      .first("state"),
  ).toBe("revoked");
  const lockToken = created.headers.get("Lock-Token");
  expect(lockToken).toMatch(/^<opaquelocktoken:[0-9a-f-]+>$/);
  const token = lockToken!.slice(1, -1);
  const createdXml = await created.text();
  expect(createdXml).toContain("<D:depth>0</D:depth>");
  expect(createdXml).toContain("<D:timeout>Second-90</D:timeout>");
  expect(createdXml).toContain("Alice &amp; Bob");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM locks WHERE node_id=?")
      .bind(f.ids.file)
      .first<number>("count"),
  ).toBe(1);
  const discovered = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPFIND",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        Depth: "0",
      },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
    }),
    davEnv,
    1,
    ring,
  );
  expect(discovered.status).toBe(207);
  const discoveredXml = await discovered.text();
  expect(discoveredXml).toContain("<D:activelock>");
  expect(discoveredXml).toContain("<D:owner>Alice &amp; Bob</D:owner>");
  expect(discoveredXml).toContain("<D:lockroot><D:href>/dav/File</D:href></D:lockroot>");
  const discoveredTimeout = /<D:timeout>Second-(\d+)<\/D:timeout>/.exec(discoveredXml);
  expect(Number(discoveredTimeout?.[1])).toBeGreaterThan(0);
  expect(Number(discoveredTimeout?.[1])).toBeLessThanOrEqual(90);
  expect(discoveredXml).not.toContain(token);

  const conflicting = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "LOCK",
      headers: { ...Object.fromEntries(request().headers), "Content-Type": "application/xml" },
      body,
    }),
    davEnv,
    1,
    ring,
  );
  expect(conflicting.status).toBe(423);

  const refreshed = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "LOCK",
      headers: {
        ...Object.fromEntries(request().headers),
        If: `(<${token}>)`,
        Timeout: "Second-120",
      },
    }),
    davEnv,
    1,
    ring,
  );
  expect(refreshed.status).toBe(200);
  expect(await refreshed.text()).toContain("<D:timeout>Second-120</D:timeout>");

  const unlocked = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "UNLOCK",
      headers: { ...Object.fromEntries(request().headers), "Lock-Token": `<${token}>` },
      body: emptyBody(),
    }),
    davEnv,
    1,
    ring,
  );
  expect(unlocked.status).toBe(204);
  expect(unlocked.body).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM locks WHERE node_id=?")
      .bind(f.ids.file)
      .first<number>("count"),
  ).toBe(0);
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/File", {
          method: "UNLOCK",
          headers: { ...Object.fromEntries(request().headers), "Lock-Token": `<${token}>` },
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(409);

  const collectionLock = await handleDavHttp(
    new Request("https://app.invalid/dav/", {
      method: "LOCK",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        Depth: "infinity",
      },
      body,
    }),
    davEnv,
    1,
    ring,
  );
  expect(collectionLock.status).toBe(200);
  const collectionToken = collectionLock.headers.get("Lock-Token");
  expect(collectionToken).toMatch(/^<opaquelocktoken:[0-9a-f-]+>$/);
  const inherited = await handleDavHttp(
    new Request("https://app.invalid/dav/File", {
      method: "PROPFIND",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        Depth: "0",
      },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
    }),
    davEnv,
    1,
    ring,
  );
  expect(inherited.status).toBe(207);
  const inheritedXml = await inherited.text();
  expect(inheritedXml).toContain("<D:depth>Infinity</D:depth>");
  expect(inheritedXml).toContain("<D:lockroot><D:href>/dav/</D:href></D:lockroot>");
  expect(inheritedXml).not.toContain(collectionToken!.slice(1, -1));
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/", {
          method: "UNLOCK",
          headers: {
            ...Object.fromEntries(request().headers),
            "Lock-Token": collectionToken!,
          },
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(204);
});

it("creates a locked empty file for LOCK on an unmapped DAV path", async () => {
  const { f, id, ring, request } = await fixture("F");
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:create'),(?,'node:read'),(?,'node:write')",
  )
    .bind(`ap:${id}`, `ap:${id}`, `ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const created = await handleDavHttp(
    new Request("https://app.invalid/dav/Empty.txt", {
      method: "LOCK",
      headers: {
        ...Object.fromEntries(request().headers),
        "Content-Type": "application/xml",
        Depth: "0",
        Timeout: "Second-60",
      },
      body: `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>
        <D:locktype><D:write/></D:locktype><D:owner>empty</D:owner></D:lockinfo>`,
    }),
    davEnv,
    1,
    ring,
  );
  expect(created.status).toBe(201);
  const lockToken = created.headers.get("Lock-Token");
  expect(lockToken).toMatch(/^<opaquelocktoken:[0-9a-f-]+>$/);
  const row = await env.DB.prepare(
    `SELECT n.id,n.last_op_id AS opId,n.current_blob_id AS blobId,b.r2_key AS r2Key,b.size,b.ref_count AS refCount,
      s.bytes,(SELECT COUNT(*) FROM locks l WHERE l.node_id=n.id) AS lockCount
      FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN blob_storage s ON s.blob_id=b.id
      WHERE n.parent_id=? AND n.name='Empty.txt' AND n.kind='file'`,
  )
    .bind(f.ids.folder)
    .first<{
      id: string;
      opId: string;
      blobId: string;
      r2Key: string;
      size: number;
      refCount: number;
      bytes: number;
      lockCount: number;
    }>();
  expect(row).toMatchObject({ size: 0, refCount: 1, bytes: 0, lockCount: 1 });
  expect(
    await env.DB.prepare(
      `SELECT o.kind,o.state,o.expected_steps AS expectedSteps,
        (SELECT COUNT(*) FROM operation_steps s WHERE s.op_id=o.op_id) AS steps,
        (SELECT COUNT(*) FROM outbox b WHERE b.op_id=o.op_id AND b.kind='node.created') AS events
        FROM operations o WHERE o.op_id=?`,
    )
      .bind(row!.opId)
      .first(),
  ).toEqual({ kind: "dav.lock", state: "committed", expectedSteps: 10, steps: 10, events: 1 });
  expect(await env.BLOBS.head(row!.r2Key)).toMatchObject({ size: 0 });
  try {
    const read = await handleDavHttp(
      new Request("https://app.invalid/dav/Empty.txt", { headers: request().headers }),
      davEnv,
      1,
      ring,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("Content-Length")).toBe("0");
    expect((await read.arrayBuffer()).byteLength).toBe(0);
    expect(
      (
        await handleDavHttp(
          new Request("https://app.invalid/dav/Empty.txt", {
            method: "UNLOCK",
            headers: {
              ...Object.fromEntries(request().headers),
              "Lock-Token": lockToken!,
            },
          }),
          davEnv,
          1,
          ring,
        )
      ).status,
    ).toBe(204);
  } finally {
    if (row) await env.BLOBS.delete(row.r2Key);
  }
});

it("streams DAV PUT creates and conditional overwrites into immutable versioned blobs", async () => {
  const { f, id, ring, request } = await fixture("G");
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:create'),(?,'node:read'),(?,'node:write')",
  )
    .bind(`ap:${id}`, `ap:${id}`, `ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const headers = Object.fromEntries(request().headers);
  const firstBody = "first DAV body";
  const created = await handleDavHttp(
    new Request("https://app.invalid/dav/Put.txt", {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Length": String(firstBody.length),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: firstBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(created.status).toBe(201);
  expect(created.headers.get("Location")).toBe("/dav/Put.txt");
  const first = await env.DB.prepare(
    `SELECT n.id,n.revision,n.current_blob_id AS blobId,b.r2_key AS r2Key,b.size,b.sha256_verified AS sha256,
      b.mime_sniffed AS mime,b.ref_count AS refCount,n.last_op_id AS opId
      FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      WHERE n.parent_id=? AND n.name='Put.txt' AND n.deleted_at IS NULL`,
  )
    .bind(f.ids.folder)
    .first<{
      id: string;
      revision: number;
      blobId: string;
      r2Key: string;
      size: number;
      sha256: string;
      mime: string;
      refCount: number;
      opId: string;
    }>();
  expect(first).toMatchObject({
    revision: 1,
    size: firstBody.length,
    mime: "text/plain",
    refCount: 1,
  });
  const expectedHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(firstBody))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  expect(first?.sha256).toBe(expectedHash);
  expect(await (await env.BLOBS.get(first!.r2Key))!.text()).toBe(firstBody);
  expect(
    await env.DB.prepare(
      "SELECT kind,state,expected_steps AS expectedSteps FROM operations WHERE op_id=?",
    )
      .bind(first!.opId)
      .first(),
  ).toEqual({ kind: "dav.put", state: "committed", expectedSteps: 10 });
  expect(
    await env.DB.prepare("SELECT state,bytes FROM reservations WHERE op_id=?")
      .bind(first!.opId)
      .first(),
  ).toEqual({ state: "consumed", bytes: firstBody.length });
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='put-create',dispatch_expires_at=?,updated_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 30_000, Date.now(), first!.opId)
    .run();
  expect(await consumeOutbox(env.DB, `${first!.opId}_event`)).toBe("completed");

  const unconditioned = await handleDavHttp(
    new Request("https://app.invalid/dav/Put.txt", {
      method: "PUT",
      headers: { ...headers, "Content-Length": "1" },
      body: "x",
    }),
    davEnv,
    1,
    ring,
  );
  expect(unconditioned.status).toBe(428);

  const read = await handleDavHttp(
    new Request("https://app.invalid/dav/Put.txt", { headers }),
    davEnv,
    1,
    ring,
  );
  const etag = read.headers.get("ETag");
  expect(etag).toBe(`"b-${first!.blobId}"`);
  const secondBody = "replacement";
  const overwritten = await handleDavHttp(
    new Request("https://app.invalid/dav/Put.txt", {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Length": String(secondBody.length),
        "Content-Type": "text/plain",
        "If-Match": etag!,
      },
      body: secondBody,
    }),
    davEnv,
    1,
    ring,
  );
  expect(overwritten.status).toBe(204);
  const current = await env.DB.prepare(
    `SELECT n.revision,n.current_blob_id AS blobId,b.r2_key AS r2Key,b.ref_count AS refCount,
      n.last_op_id AS opId,(SELECT COUNT(*) FROM node_versions v WHERE v.node_id=n.id AND v.blob_id=?) AS versions
      FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?`,
  )
    .bind(first!.blobId, first!.id)
    .first<{
      revision: number;
      blobId: string;
      r2Key: string;
      refCount: number;
      opId: string;
      versions: number;
    }>();
  expect(current).toMatchObject({ revision: 2, refCount: 1, versions: 1 });
  expect(current?.blobId).not.toBe(first?.blobId);
  expect(await (await env.BLOBS.get(current!.r2Key))!.text()).toBe(secondBody);
  expect(
    await env.DB.prepare(
      "SELECT kind,state,expected_steps AS expectedSteps FROM operations WHERE op_id=?",
    )
      .bind(current!.opId)
      .first(),
  ).toEqual({ kind: "dav.put", state: "committed", expectedSteps: 8 });
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='put-update',dispatch_expires_at=?,updated_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 30_000, Date.now(), current!.opId)
    .run();
  expect(await consumeOutbox(env.DB, `${current!.opId}_event`)).toBe("completed");
  await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?").bind(f.ids.user).run();
  const beforeQuotaFailure = await env.BLOBS.list({ prefix: `u/${f.ids.user}/b/` });
  const quotaFailure = await handleDavHttp(
    new Request("https://app.invalid/dav/Quota.txt", {
      method: "PUT",
      headers: { ...headers, "Content-Length": "1" },
      body: "x",
    }),
    davEnv,
    1,
    ring,
  );
  expect(quotaFailure.status).toBe(507);
  expect(
    (await env.BLOBS.list({ prefix: `u/${f.ids.user}/b/` })).objects.map(({ key }) => key).sort(),
  ).toEqual(beforeQuotaFailure.objects.map(({ key }) => key).sort());
  expect(
    await env.DB.prepare(
      "SELECT state,error_code AS errorCode FROM operations WHERE kind='dav.put' AND error_code='quota_exceeded'",
    ).first(),
  ).toEqual({ state: "failed", errorCode: "quota_exceeded" });
  const locked = await handleDavHttp(
    new Request("https://app.invalid/dav/Put.txt", {
      method: "LOCK",
      headers: {
        ...headers,
        "Content-Type": "application/xml",
        Depth: "0",
        Timeout: "Second-60",
      },
      body: `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>
        <D:locktype><D:write/></D:locktype></D:lockinfo>`,
    }),
    davEnv,
    1,
    ring,
  );
  expect(locked.status).toBe(200);
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/Put.txt", {
          method: "PUT",
          headers: {
            ...headers,
            "Content-Length": "1",
            "If-Match": `"b-${current!.blobId}"`,
          },
          body: "x",
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(423);
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/Put.txt", {
          method: "UNLOCK",
          headers: { ...headers, "Lock-Token": locked.headers.get("Lock-Token")! },
        }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(204);
  await env.BLOBS.delete(first!.r2Key);
  await env.BLOBS.delete(current!.r2Key);
});

it("atomically trashes a bounded DAV subtree and revokes its locks and shares", async () => {
  const { f, id, ring, request } = await fixture("H");
  const credential = `ap:${id}`;
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read'),(?,'node:delete'),(?,'node:write')",
  )
    .bind(credential, credential, credential)
    .run();
  const folder = `${f.ids.folder}-delete`;
  const child = `${f.ids.file}-delete`;
  const now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,'Delete me','delete me','folder',?,?)`,
      values: [folder, f.ids.space, f.ids.user, f.ids.folder, now, now],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        VALUES(?,?,?,?,'Child.txt','child.txt','file',?,?,?)`,
      values: [child, f.ids.space, f.ids.user, folder, f.ids.blob, now, now],
    },
    {
      sql: `INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)`,
      values: [`${child}-share`, f.ids.user, child, now],
    },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,?,1,?,?)`,
      values: [`${child}-share-session`, `${child}-share`, `${child}-digest`, now, now + 600_000],
    },
    {
      sql: "INSERT INTO budgets(id,owner_id,share_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [`${child}-budget`, f.ids.user, `${child}-share`, now + 600_000],
    },
    {
      sql: `INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,'hash','manifest',3,?,1)`,
      values: [`${child}-targets`, f.ids.user, credential, now + 600_000],
    },
    {
      sql: `INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
        VALUES(?,?,?,?, 'content',1,?,?)`,
      values: [
        `${child}-ticket`,
        credential,
        `${child}-targets`,
        `${child}-budget`,
        now,
        now + 600_000,
      ],
    },
    {
      sql: `INSERT INTO content_sessions(id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,
        epoch,issued_at,expires_at,ticket_id) VALUES(?, ?,1,?,?,?,1,?,?,?)`,
      values: [
        `${child}-content`,
        `${child}-share`,
        credential,
        `${child}-targets`,
        `${child}-budget`,
        now,
        now + 600_000,
        `${child}-ticket`,
      ],
    },
  ]);
  const davEnv = admittedDavEnv();
  const headers = Object.fromEntries(request().headers);
  const locked = await handleDavHttp(
    new Request("https://app.invalid/dav/Delete%20me/Child.txt", {
      method: "LOCK",
      headers: {
        ...headers,
        "Content-Type": "application/xml",
        Depth: "0",
        Timeout: "Second-60",
      },
      body: `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>
        <D:locktype><D:write/></D:locktype></D:lockinfo>`,
    }),
    davEnv,
    1,
    ring,
  );
  expect(locked.status).toBe(200);
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/Delete%20me", { method: "DELETE", headers }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(423);
  const deleted = await handleDavHttp(
    new Request("https://app.invalid/dav/Delete%20me", {
      method: "DELETE",
      headers: {
        ...headers,
        If: `<https://app.invalid/dav/Delete%20me/Child.txt> (${locked.headers.get("Lock-Token")})`,
      },
      body: emptyBody(),
    }),
    davEnv,
    1,
    ring,
  );
  expect(deleted.status).toBe(204);
  const operation = await env.DB.prepare(
    `SELECT o.op_id AS opId,o.state,o.expected_steps AS expectedSteps,
      (SELECT COUNT(*) FROM operation_steps s WHERE s.op_id=o.op_id) AS steps
      FROM operations o WHERE o.kind='dav.delete' AND o.state='committed'`,
  ).first<{ opId: string; state: string; expectedSteps: number; steps: number }>();
  expect(operation).toMatchObject({ state: "committed", expectedSteps: 13, steps: 13 });
  expect(
    await env.DB.prepare(
      `SELECT t.state,(SELECT COUNT(*) FROM trash_members m WHERE m.trash_op_id=t.op_id) AS members,
        (SELECT COUNT(*) FROM nodes n WHERE n.deleted_op_id=t.op_id) AS deletedNodes,
        (SELECT COUNT(*) FROM locks l WHERE l.node_id IN (?,?)) AS locks
        FROM trash_ops t WHERE t.op_id=?`,
    )
      .bind(folder, child, operation!.opId)
      .first(),
  ).toEqual({ state: "trashed", members: 2, deletedNodes: 2, locks: 0 });
  expect(
    await env.DB.prepare(
      `SELECT sh.version,sh.disabled_at IS NOT NULL AS disabled,
        ss.revoked_at IS NOT NULL AS shareRevoked,cs.revoked_at IS NOT NULL AS contentRevoked,
        tk.cancelled_at IS NOT NULL AS ticketCancelled
        FROM shares sh JOIN share_sessions ss ON ss.share_id=sh.id
        JOIN content_sessions cs ON cs.share_id=sh.id JOIN tickets tk ON tk.id=cs.ticket_id
        WHERE sh.id=?`,
    )
      .bind(`${child}-share`)
      .first(),
  ).toEqual({
    version: 2,
    disabled: 1,
    shareRevoked: 1,
    contentRevoked: 1,
    ticketCancelled: 1,
  });
  expect(await consumeOutbox(env.DB, `${operation!.opId}_event`)).toBe("retry");
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='trash',dispatch_expires_at=?,updated_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 30_000, Date.now(), operation!.opId)
    .run();
  expect(await consumeOutbox(env.DB, `${operation!.opId}_event`)).toBe("completed");
  expect(
    (
      await handleDavHttp(
        new Request("https://app.invalid/dav/Delete%20me", { headers }),
        davEnv,
        1,
        ring,
      )
    ).status,
  ).toBe(404);
});

it("rejects a DAV DELETE subtree larger than the synchronous 1,000-node bound", async () => {
  const { f, id, ring, request } = await fixture("J");
  const credential = `ap:${id}`;
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read'),(?,'node:delete')",
  )
    .bind(credential, credential)
    .run();
  const folder = `${f.ids.folder}-large-delete`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      VALUES(?,?,?,?,'Large delete','large delete','folder',?,?)`,
  )
    .bind(folder, f.ids.space, f.ids.user, f.ids.folder, now, now)
    .run();
  await env.DB.prepare(
    `WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<1000)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      SELECT ?||'-'||x,?,?,?,'n'||printf('%04d',x),'n'||printf('%04d',x),'folder',?,? FROM seq`,
  )
    .bind(folder, f.ids.space, f.ids.user, folder, now, now)
    .run();
  const response = await handleDavHttp(
    new Request("https://app.invalid/dav/Large%20delete", {
      method: "DELETE",
      headers: request().headers,
    }),
    admittedDavEnv(),
    1,
    ring,
  );
  expect(response.status).toBe(403);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE id=? AND deleted_at IS NULL")
      .bind(folder)
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM operations WHERE kind='dav.delete' AND instr(operands_json,?)>0",
    )
      .bind(folder)
      .first(),
  ).toEqual({ count: 0 });
});

it("parses bounded DAV paths with a single percent decode", () => {
  expect(parseDavPath("/dav")).toMatchObject({ segments: [], trailingSlash: false });
  expect(parseDavPath("/dav/Folder/a%20b.txt").segments.map((part) => part.name)).toEqual([
    "Folder",
    "a b.txt",
  ]);
  for (const path of [
    "/dav//File",
    "/dav/%2F",
    "/dav/%5C",
    "/dav/%252F",
    "/dav/%00",
    "/dav/%FF",
    "/dav/%",
    "/dav/./File",
    `/dav/${"a/".repeat(65)}File`,
  ]) {
    expect(() => parseDavPath(path)).toThrow("invalid_dav_path");
  }
  expect(() => parseDavPath("/dav/Shared/mount")).toThrow("dav_shared_not_ready");
});

it("resolves an app password DAV path relative to its authorized root", async () => {
  const { f, id, ring, request } = await fixture("7");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  const principal = await authenticateAppPassword(
    env.DB,
    request(),
    "https://app.invalid",
    1,
    ring,
  );
  expect((await resolveDavNode(env.DB, principal, parseDavPath("/dav"))).node.id).toBe(
    f.ids.folder,
  );
  expect((await resolveDavNode(env.DB, principal, parseDavPath("/dav/file"))).node.id).toBe(
    f.ids.file,
  );
  await expect(resolveDavNode(env.DB, principal, parseDavPath("/dav/Folder"))).rejects.toThrow(
    "dav_node_unavailable",
  );
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
    .bind(Date.now(), id)
    .run();
  await expect(resolveDavNode(env.DB, principal, parseDavPath("/dav/File"))).rejects.toThrow(
    "dav_node_unavailable",
  );
});

it("rejects a DAV path whose node moves after its initial lookup", async () => {
  const { f, id, ring, request } = await fixture("8");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
    .bind(`ap:${id}`)
    .run();
  const principal = await authenticateAppPassword(
    env.DB,
    request(),
    "https://app.invalid",
    1,
    ring,
  );
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.prepare("UPDATE nodes SET name='Moved',name_ci='moved' WHERE id=?")
        .bind(f.ids.file)
        .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  await expect(resolveDavNode(db, principal, parseDavPath("/dav/File"))).rejects.toThrow(
    "dav_node_unavailable",
  );
});

it("moves a DAV resource to a strict same-origin destination", async () => {
  const { f, id, ring, request } = await fixture("M");
  const destination = `${f.ids.folder}-move-target`;
  const sourceSearch = searchName("File");
  const destinationSearch = searchName("Target");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read'),(?,'node:write'),(?,'node:create'),(?,'node:delete')",
      values: [`ap:${id}`, `ap:${id}`, `ap:${id}`, `ap:${id}`],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',1,1)`,
      values: [destination, f.ids.space, f.ids.user, f.ids.folder, "Target", "target"],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1),(?,?,?,?,?,1)`,
      values: [
        f.ids.file,
        f.ids.space,
        sourceSearch.textNorm,
        sourceSearch.tokens,
        sourceSearch.version,
        destination,
        f.ids.space,
        destinationSearch.textNorm,
        destinationSearch.tokens,
        destinationSearch.version,
      ],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id IN (?,?)",
      values: [f.ids.file, destination],
    },
  ]);
  const headers = {
    ...Object.fromEntries(request().headers),
    Destination: "https://app.invalid/dav/Target/Moved.txt",
    Overwrite: "F",
    Depth: "infinity",
  };
  const moved = await handleDavHttp(
    new Request("https://app.invalid/dav/File", { method: "MOVE", headers, body: emptyBody() }),
    admittedDavEnv(),
    1,
    ring,
  );
  expect(moved.status).toBe(201);
  expect(moved.headers.get("Location")).toBe("/dav/Target/Moved.txt");
  expect(
    await env.DB.prepare("SELECT parent_id,name FROM nodes WHERE id=?").bind(f.ids.file).first(),
  ).toEqual({ parent_id: destination, name: "Moved.txt" });
  expect(
    await handleDavHttp(
      new Request("https://app.invalid/dav/Target/Moved.txt", {
        method: "MOVE",
        headers: {
          ...headers,
          Destination: "https://app.invalid/dav/Target/Moved.txt",
          Overwrite: "T",
        },
      }),
      admittedDavEnv(),
      1,
      ring,
    ),
  ).toMatchObject({ status: 403 });
  expect(
    await handleDavHttp(
      new Request("https://app.invalid/dav/Target/Moved.txt", {
        method: "MOVE",
        headers: { ...headers, Destination: "https://other.invalid/dav/stolen" },
      }),
      admittedDavEnv(),
      1,
      ring,
    ),
  ).toMatchObject({ status: 400 });

  const secondSource = `${f.ids.folder}-move-source-2`;
  const overwritten = `${f.ids.folder}-overwrite-target`;
  const secondSearch = searchName("Second source");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',1,1),(?,?,?,?,?,?,'folder',1,1)`,
      values: [
        secondSource,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        "Second source",
        "second source",
        overwritten,
        f.ids.space,
        f.ids.user,
        destination,
        "Existing",
        "existing",
      ],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1)`,
      values: [
        secondSource,
        f.ids.space,
        secondSearch.textNorm,
        secondSearch.tokens,
        secondSearch.version,
      ],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [secondSource],
    },
  ]);
  const replaced = await handleDavHttp(
    new Request("https://app.invalid/dav/Second%20source", {
      method: "MOVE",
      headers: {
        ...Object.fromEntries(request().headers),
        Destination: "https://app.invalid/dav/Target/Existing",
        Overwrite: "T",
      },
    }),
    admittedDavEnv(),
    1,
    ring,
  );
  expect(replaced.status).toBe(204);
  expect(
    await env.DB.prepare("SELECT parent_id,name,deleted_at FROM nodes WHERE id=?")
      .bind(secondSource)
      .first(),
  ).toEqual({ parent_id: destination, name: "Existing", deleted_at: null });
  expect(
    await env.DB.prepare("SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE id=?")
      .bind(overwritten)
      .first("deleted"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE root_node_id=?")
      .bind(overwritten)
      .first("state"),
  ).toBe("trashed");
});

it("copies and atomically overwrites a DAV resource with COW storage", async () => {
  const { f, id, ring, request } = await fixture("K");
  const sourceSearch = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read'),(?,'node:create'),(?,'node:delete')",
      values: [`ap:${id}`, `ap:${id}`, `ap:${id}`],
    },
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [
        f.ids.file,
        f.ids.space,
        sourceSearch.textNorm,
        sourceSearch.tokens,
        sourceSearch.version,
      ],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const davEnv = admittedDavEnv();
  const base = Object.fromEntries(request().headers);
  const send = (overwrite: "T" | "F") =>
    handleDavHttp(
      new Request("https://app.invalid/dav/File", {
        method: "COPY",
        headers: {
          ...base,
          Destination: "https://app.invalid/dav/File-copy",
          Depth: "0",
          Overwrite: overwrite,
        },
        body: emptyBody(),
      }),
      davEnv,
      1,
      ring,
    );
  const created = await send("F");
  expect(created.status).toBe(201);
  expect(created.headers.get("Location")).toBe("/dav/File-copy");
  const first = await env.DB.prepare(
    "SELECT id,current_blob_id FROM nodes WHERE parent_id=? AND name_ci='file-copy' AND deleted_at IS NULL",
  )
    .bind(f.ids.folder)
    .first<{ id: string; current_blob_id: string }>();
  expect(first?.current_blob_id).toBe(f.ids.blob);
  expect((await send("F")).status).toBe(412);
  const replaced = await send("T");
  expect(replaced.status).toBe(204);
  expect(
    await env.DB.prepare("SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE id=?")
      .bind(first!.id)
      .first("deleted"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM nodes WHERE parent_id=? AND name_ci='file-copy' AND deleted_at IS NULL",
    )
      .bind(f.ids.folder)
      .first("COUNT(*)"),
  ).toBe(1);
});
