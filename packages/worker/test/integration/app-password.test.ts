import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

function admittedDavEnv(): Env {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }) }),
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
  const ring = await appPasswordPepperRing("v1", { v1: pepper });
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
  const other = await appPasswordPepperRing("v2", {
    v2: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
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
  const ring = await appPasswordPepperRing("v2", { v1: pepper, v2: next });
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
  const currentOnly = await appPasswordPepperRing("v2", { v2: next });
  await expect(
    authenticateAppPassword(env.DB, request(), "https://app.invalid", 1, currentOnly),
  ).resolves.toMatchObject({ kind: "app_password" });
});

it("accepts a committed rotation when the D1 acknowledgement is lost", async () => {
  const { id, pepper, request } = await fixture("5");
  const ring = await appPasswordPepperRing("v2", {
    v1: pepper,
    v2: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
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
    "OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, MKCOL, LOCK, UNLOCK",
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
    body?: string,
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
  const created = await send();
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
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'0','owner',1,?)",
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
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'0','owner',1,?)",
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

it("creates, refreshes and removes an existing-resource DAV lock", async () => {
  const { f, id, ring, request } = await fixture("E");
  await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:write')")
    .bind(`ap:${id}`)
    .run();
  const davEnv = admittedDavEnv();
  const body = `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>
    <D:locktype><D:write/></D:locktype><D:owner>Alice &amp; Bob</D:owner></D:lockinfo>`;
  const created = await handleDavHttp(
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
  expect(created.status).toBe(200);
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
