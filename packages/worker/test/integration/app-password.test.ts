import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  appPasswordPepperRing,
  authenticateAppPassword,
  hashAppPassword,
} from "../../src/auth/appPassword";
import { atomicBatch } from "../../src/db/primary";
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
