import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import {
  handlePrivateAppHttp,
  type PrivateAppDependencies,
  privateAppRoute,
} from "../../src/api/privateApp";
import { AutomationCursorTokens } from "../../src/auth/automationCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function setup() {
  const now = Date.now();
  const owner = foundationFixture(crypto.randomUUID(), now - 1000);
  const other = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, [...owner.statements, ...other.statements]);
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  const serviceId = `svc-${crypto.randomUUID()}`;
  const credentialId = `sv:${serviceId}`;
  const commonName = `job-${crypto.randomUUID()}@example.invalid`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO service_principals(id,access_iss,common_name,mapped_user_id,space_id,root_node_id) VALUES(?,?,?,?,?,?)",
      values: [
        serviceId,
        "https://access.invalid",
        commonName,
        owner.ids.user,
        owner.ids.space,
        owner.ids.folder,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,service_principal_id) VALUES(?,'service',?)",
      values: [credentialId, serviceId],
    },
    {
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')",
      values: [credentialId],
    },
  ]);
  const access = await accessFixture();
  const ring = await contentKeyRing("one", {
    one: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const app = { APP_ORIGIN: "https://app.invalid", DB: env.DB } as Env;
  const request = async (
    path = "/api/v1/automation/nodes",
    changes: Record<string, unknown> = {},
  ) => {
    const req = await access.sign({
      aud: ["service-aud"],
      type: "app",
      common_name: commonName,
      sub: "",
      email: undefined,
      ...changes,
    });
    return new Request(`https://app.invalid${path}`, { headers: req.headers });
  };
  const dependencies = {
    verifier: access.verifier,
    cursors: new NodeCursorTokens(ring),
  } as unknown as PrivateAppDependencies;
  const handle = (req: Request) => {
    expect(privateAppRoute(req)).toBe(true);
    return handlePrivateAppHttp(req, app, 1, dependencies);
  };
  const cleanup = async () => {
    await env.DB.prepare("DELETE FROM credential_scopes WHERE credential_id=?")
      .bind(credentialId)
      .run();
    await env.DB.prepare("DELETE FROM credentials WHERE id=?").bind(credentialId).run();
    await env.DB.prepare("DELETE FROM service_principals WHERE id=?").bind(serviceId).run();
  };
  return {
    owner,
    other,
    serviceId,
    credentialId,
    commonName,
    access,
    ring,
    request,
    handle,
    cleanup,
  };
}

it("serves scoped metadata and a stable cursor-bound root listing only to a mapped service JWT", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 201; i++) {
      await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'file',?,?)`)
        .bind(
          `auto-${i}-${crypto.randomUUID()}`,
          f.owner.ids.space,
          f.owner.ids.user,
          f.owner.ids.folder,
          `entry${i}`,
          `entry${i}`,
          Date.now(),
          Date.now(),
        )
        .run();
    }
    const first = await f.handle(await f.request());
    expect(first.status).toBe(200);
    const page = await first.json<{
      nodes: Array<{ id: string }>;
      nextCursor: string | null;
      scopeRootId: string;
    }>();
    expect(page.scopeRootId).toBe(f.owner.ids.folder);
    expect(page.nodes).toHaveLength(200);
    expect(page.nextCursor).toBeTruthy();
    const second = await f.handle(
      await f.request(`/api/v1/automation/nodes?cursor=${encodeURIComponent(page.nextCursor!)}`),
    );
    expect(second.status).toBe(200);
    expect(
      (await second.json<{ nodes: unknown[]; nextCursor: string | null }>()).nodes,
    ).toHaveLength(2);

    const detail = await f.handle(await f.request(`/api/v1/automation/nodes/${f.owner.ids.file}`));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: f.owner.ids.file,
      ownerId: f.owner.ids.user,
      spaceId: f.owner.ids.space,
    });
    expect(
      (await f.handle(await f.request(`/api/v1/automation/nodes/${f.other.ids.file}`))).status,
    ).toBe(404);
  } finally {
    await f.cleanup();
  }
});

it("rejects user JWTs, wrong service issuer/AUD, and unmapped common names", async () => {
  const f = await setup();
  try {
    expect(
      (
        await f.handle(
          await f.request("/api/v1/automation/nodes", {
            aud: ["private-aud"],
            common_name: undefined,
            sub: "owner",
            email: "x@example.invalid",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.handle(
          await f.request("/api/v1/automation/nodes", { iss: "https://wrong.invalid" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await f.handle(await f.request("/api/v1/automation/nodes", { aud: ["wrong-aud"] }))).status,
    ).toBe(401);
    expect(
      (
        await f.handle(
          await f.request("/api/v1/automation/nodes", { common_name: "unmapped@example.invalid" }),
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.cleanup();
  }
});

it("rechecks disabled principal, removed scope, changed root/space and rejects cursor tampering or reuse", async () => {
  const f = await setup();
  try {
    const cursor = await new AutomationCursorTokens(f.ring).issue({
      servicePrincipalId: f.serviceId,
      credentialId: f.credentialId,
      mappedUserId: f.owner.ids.user,
      spaceId: f.owner.ids.space,
      scopeRootId: f.owner.ids.folder,
      generation: 1,
      lastNameCi: "x",
      lastId: "x-id",
      epoch: 1,
    });
    const sibling = `outside-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      VALUES(?,?,?,?,'outside','outside','file',?,?)`)
      .bind(sibling, f.owner.ids.space, f.owner.ids.user, f.owner.ids.root, Date.now(), Date.now())
      .run();
    expect((await f.handle(await f.request(`/api/v1/automation/nodes/${sibling}`))).status).toBe(
      404,
    );
    await env.DB.prepare("UPDATE service_principals SET space_id=? WHERE id=?")
      .bind(f.other.ids.space, f.serviceId)
      .run();
    expect(
      (await f.handle(await f.request(`/api/v1/automation/nodes/${f.owner.ids.file}`))).status,
    ).toBe(404);
    await env.DB.prepare("UPDATE service_principals SET space_id=? WHERE id=?")
      .bind(f.owner.ids.space, f.serviceId)
      .run();
    await env.DB.prepare("UPDATE service_principals SET root_node_id=? WHERE id=?")
      .bind(f.owner.ids.root, f.serviceId)
      .run();
    expect(
      (
        await f.handle(
          await f.request(`/api/v1/automation/nodes?cursor=${encodeURIComponent(cursor)}`),
        )
      ).status,
    ).toBe(400);
    await env.DB.prepare("UPDATE service_principals SET root_node_id=? WHERE id=?")
      .bind(f.owner.ids.folder, f.serviceId)
      .run();
    const damaged = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expect(
      (
        await f.handle(
          await f.request(`/api/v1/automation/nodes?cursor=${encodeURIComponent(damaged)}`),
        )
      ).status,
    ).toBe(400);
    const otherServiceId = `svc-${crypto.randomUUID()}`;
    const otherCredential = `sv:${otherServiceId}`;
    const otherCommonName = `other-${crypto.randomUUID()}@example.invalid`;
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO service_principals(id,access_iss,common_name,mapped_user_id,space_id,root_node_id) VALUES(?,'https://access.invalid',?,?,?,?)",
        values: [
          otherServiceId,
          otherCommonName,
          f.owner.ids.user,
          f.owner.ids.space,
          f.owner.ids.folder,
        ],
      },
      {
        sql: "INSERT INTO credentials(id,kind,service_principal_id) VALUES(?,'service',?)",
        values: [otherCredential, otherServiceId],
      },
      {
        sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')",
        values: [otherCredential],
      },
    ]);
    expect(
      (
        await f.handle(
          await f.request(`/api/v1/automation/nodes?cursor=${encodeURIComponent(cursor)}`, {
            common_name: otherCommonName,
          }),
        )
      ).status,
    ).toBe(400);
    await env.DB.prepare("DELETE FROM credential_scopes WHERE credential_id=?")
      .bind(otherCredential)
      .run();
    await env.DB.prepare("DELETE FROM credentials WHERE id=?").bind(otherCredential).run();
    await env.DB.prepare("DELETE FROM service_principals WHERE id=?").bind(otherServiceId).run();
    await env.DB.prepare("DELETE FROM credential_scopes WHERE credential_id=?")
      .bind(f.credentialId)
      .run();
    expect((await f.handle(await f.request())).status).toBe(404);
    await env.DB.prepare("INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:read')")
      .bind(f.credentialId)
      .run();
    await env.DB.prepare("UPDATE service_principals SET disabled_at=? WHERE id=?")
      .bind(Date.now(), f.serviceId)
      .run();
    expect((await f.handle(await f.request())).status).toBe(403);
  } finally {
    await f.cleanup();
  }
});
