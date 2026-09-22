import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleDavHttp } from "../../src/api/dav";
import {
  appPasswordPepperRing,
  authenticateAppPassword,
  hashAppPassword,
} from "../../src/auth/appPassword";
import { parseDavPath, resolveDavNode } from "../../src/dav/path";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

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
  expect(options.headers.get("Allow")).toBe("OPTIONS, GET, HEAD");
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
  expect(zeroXml).toContain(`<D:getetag>&quot;${f.ids.file}-1&quot;</D:getetag>`);
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
