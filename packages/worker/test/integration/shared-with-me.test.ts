import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleShareHttp, shareRoute } from "../../src/api/shares";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

it("serves the direct-user lifecycle through private JSON and CSRF routes", async () => {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    {
      sql: "UPDATE users SET email='owner@example.invalid' WHERE id=?",
      values: [owner.ids.user],
    },
    {
      sql: "UPDATE users SET email='recipient@example.invalid' WHERE id=?",
      values: [recipient.ids.user],
    },
  ]);
  const ownerSession = await readAccessSession(env.DB, owner.ids.credential, 1);
  const recipientSession = await readAccessSession(env.DB, recipient.ids.credential, 1);
  if (!ownerSession || !recipientSession) throw new Error("fixture_session_missing");
  const csrf = { verify: vi.fn(async () => undefined) };
  const serviceEnv = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const createRequest = new Request("https://app.invalid/api/v1/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "internal",
      rootNodeId: owner.ids.folder,
      spaceId: owner.ids.space,
      recipientEmail: "recipient@example.invalid",
      actions: ["read", "download", "create", "edit"],
    }),
  });
  expect(shareRoute(createRequest)).toBe(true);
  const createdResponse = await handleShareHttp(createRequest, serviceEnv, ownerSession, csrf);
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as {
    id: string;
    mountName: string;
    actions: string[];
    expiresAt: number | null;
  };
  expect(created).toMatchObject({ actions: ["read", "download", "create", "edit"] });
  expect(csrf.verify).toHaveBeenCalledOnce();

  const sharedResponse = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shared-with-me"),
    serviceEnv,
    recipientSession,
    csrf,
  );
  expect(sharedResponse.status).toBe(200);
  await expect(sharedResponse.json()).resolves.toEqual({
    shares: [
      expect.objectContaining({
        shareId: created.id,
        mountName: created.mountName,
        actions: ["read", "download", "create", "edit"],
        expiresAt: created.expiresAt ?? null,
        delegationDepth: 0,
        reshareAuthority: null,
        provenance: { kind: "direct", recipientVersion: 1 },
      }),
    ],
  });

  const updatedResponse = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions: ["read"] }),
    }),
    serviceEnv,
    ownerSession,
    csrf,
  );
  expect(updatedResponse.status).toBe(200);
  await expect(updatedResponse.json()).resolves.toEqual(
    expect.objectContaining({ version: 2, actions: ["read"] }),
  );

  const revokedResponse = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${created.id}`, {
      method: "DELETE",
    }),
    serviceEnv,
    ownerSession,
    csrf,
  );
  expect(revokedResponse.status).toBe(204);
  const afterRevoke = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shared-with-me"),
    serviceEnv,
    recipientSession,
    csrf,
  );
  await expect(afterRevoke.json()).resolves.toEqual({ shares: [] });
});
