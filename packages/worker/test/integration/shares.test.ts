import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { readAccessSession } from "../../src/auth/sessions";
import {
  type SharePasswordPepperRing,
  sharePasswordPepperRing,
} from "../../src/auth/sharePassword";
import { atomicBatch } from "../../src/db/primary";
import {
  createInternalShare,
  createShare,
  disableShare,
  listSharedWithMe,
  listShares,
  readShare,
  updateInternalShareActions,
} from "../../src/services/shares";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";

let passwordRing: SharePasswordPepperRing;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  passwordRing = await sharePasswordPepperRing(
    "v1",
    { v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    localKdf,
  );
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture() {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...owner.statements, ...other.statements]);
  const session = await readAccessSession(env.DB, owner.ids.credential, 1);
  const otherSession = await readAccessSession(env.DB, other.ids.credential, 1);
  if (!session || !otherSession) throw new Error("fixture_session_missing");
  return { owner, other, session, otherSession };
}

it("creates a one-time capability for an owner-authorized root and lists metadata only", async () => {
  const f = await fixture();
  const created = await createShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    ttlDays: 7,
  });
  expect(created).toMatchObject({
    rootNodeId: f.owner.ids.folder,
    version: 1,
    disabledAt: null,
    actions: ["read", "download"],
    passwordProtected: false,
  });
  expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const stored = await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
    .bind(created.id)
    .first<string>("secret_digest");
  expect(stored).toBeTruthy();
  expect(stored).not.toBe(created.secret);
  expect(await listShares(env.DB, f.session)).toEqual([
    expect.objectContaining({ id: created.id, rootNodeId: f.owner.ids.folder }),
  ]);
  expect(await readShare(env.DB, f.session, created.id)).not.toHaveProperty("secret");
  await expect(readShare(env.DB, f.otherSession, created.id)).rejects.toThrow("share_not_found");
  await expect(
    createShare(mutationEnv(), f.session, {
      rootNodeId: f.other.ids.folder,
      spaceId: f.other.ids.space,
    }),
  ).rejects.toThrow("share_root_not_found");
});

it("manages a stable direct-user share mount and fails closed after revoke", async () => {
  const f = await fixture();
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: ["owner@example.invalid", f.owner.ids.user],
    },
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: ["recipient@example.invalid", f.other.ids.user],
    },
  ]);
  const created = await createInternalShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: "RECIPIENT@example.invalid",
    actions: ["read", "download"],
  });
  expect(created).toMatchObject({
    kind: "internal",
    rootNodeId: f.owner.ids.folder,
    recipientUserId: f.other.ids.user,
    actions: ["read", "download"],
    mountId: created.id,
  });
  expect(created.mountName).toMatch(/^[A-Z0-9]{26}-Folder$/);
  expect(await listSharedWithMe(env.DB, f.otherSession)).toEqual([
    expect.objectContaining({
      shareId: created.id,
      mountName: created.mountName,
      actions: ["read", "download"],
      root: expect.objectContaining({ id: f.owner.ids.folder, name: "Folder" }),
    }),
  ]);
  await env.DB.prepare("UPDATE nodes SET name='Renamed',name_ci='renamed' WHERE id=?")
    .bind(f.owner.ids.folder)
    .run();
  expect((await listSharedWithMe(env.DB, f.otherSession))[0]?.mountName).toBe(created.mountName);
  const updated = await updateInternalShareActions(mutationEnv(), f.session, created.id, ["read"]);
  expect(updated).toMatchObject({ version: 2, actions: ["read"], mountName: created.mountName });
  expect(await listSharedWithMe(env.DB, f.otherSession)).toEqual([
    expect.objectContaining({ shareVersion: 2, actions: ["read"] }),
  ]);
  await disableShare(mutationEnv(), f.session, created.id);
  expect(await listSharedWithMe(env.DB, f.otherSession)).toEqual([]);
});

it("hides internal shares after maintenance, recipient disable, expiry, or ancestor trash", async () => {
  const variants = ["maintenance", "recipient-disabled", "expired", "ancestor-trashed"] as const;
  for (const variant of variants) {
    const f = await fixture();
    await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
      .bind(`${crypto.randomUUID()}@example.invalid`, f.other.ids.user)
      .run();
    const recipientEmail = await env.DB.prepare("SELECT email FROM users WHERE id=?")
      .bind(f.other.ids.user)
      .first<string>("email");
    const shareRoot =
      variant === "ancestor-trashed" ? `${crypto.randomUUID()}-shared-folder` : f.owner.ids.folder;
    if (variant === "ancestor-trashed")
      await env.DB.prepare(
        `INSERT INTO nodes(
          id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
        ) VALUES(?,?,?,?,'Shared folder','shared folder','folder',?,?)`,
      )
        .bind(
          shareRoot,
          f.owner.ids.space,
          f.owner.ids.user,
          f.owner.ids.folder,
          Date.now(),
          Date.now(),
        )
        .run();
    const created = await createInternalShare(mutationEnv(), f.session, {
      rootNodeId: shareRoot,
      spaceId: f.owner.ids.space,
      recipientEmail: recipientEmail!,
      actions: ["read"],
    });
    if (variant === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (variant === "recipient-disabled")
      await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
        .bind(Date.now(), f.other.ids.user)
        .run();
    if (variant === "expired")
      await env.DB.prepare("UPDATE shares SET expires_at=? WHERE id=?").bind(0, created.id).run();
    if (variant === "ancestor-trashed") {
      const op = crypto.randomUUID();
      await atomicBatch(env.DB, [
        {
          sql: `INSERT INTO trash_ops(
                op_id,actor_id,space_id,root_node_id,state,created_at,epoch
              ) VALUES(?,?,?,?,'trashed',?,1)`,
          values: [op, f.owner.ids.user, f.owner.ids.space, f.owner.ids.folder, Date.now()],
        },
        {
          sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
          values: [Date.now(), op, f.owner.ids.folder],
        },
      ]);
    }
    if (variant === "maintenance" || variant === "recipient-disabled")
      await expect(listSharedWithMe(env.DB, f.otherSession)).rejects.toThrow();
    else await expect(listSharedWithMe(env.DB, f.otherSession)).resolves.toEqual([]);
    await env.DB.prepare("UPDATE control SET maintenance=0").run();
  }
});

it("stores password KDF metadata without returning the password or digest", async () => {
  const f = await fixture();
  const password = "shared only out of band";
  const created = await createShare(
    mutationEnv(),
    f.session,
    {
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      password,
    },
    passwordRing,
  );
  expect(created).toMatchObject({ passwordProtected: true });
  expect(created).not.toHaveProperty("password");
  expect(created).not.toHaveProperty("passwordDigest");
  const stored = await env.DB.prepare(
    `SELECT password_digest AS passwordDigest,salt,kdf,kdf_params AS kdfParams,kid
      FROM shares WHERE id=?`,
  )
    .bind(created.id)
    .first<{
      passwordDigest: string;
      salt: string;
      kdf: string;
      kdfParams: string;
      kid: string;
    }>();
  expect(stored).toMatchObject({
    kdf: "PBKDF2-SHA256",
    kdfParams: '{"iterations":100000}',
    kid: "v1",
  });
  expect(stored?.passwordDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(stored?.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(JSON.stringify(stored)).not.toContain(password);
  expect(await readShare(env.DB, f.session, created.id)).toMatchObject({
    passwordProtected: true,
  });
  await expect(
    createShare(mutationEnv(), f.session, {
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      password,
    }),
  ).rejects.toThrow("share_password_unavailable");
  await expect(
    createShare(
      mutationEnv(),
      f.session,
      {
        rootNodeId: f.owner.ids.folder,
        spaceId: f.owner.ids.space,
        password: "",
      },
      passwordRing,
    ),
  ).rejects.toThrow("invalid_share_password");
});

it("creates folder-only upload shares with bounded owner-visible reservations", async () => {
  const f = await fixture();
  const created = await createShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    kind: "upload_only",
    reservationLimitBytes: 1024 ** 3,
  });
  expect(created).toMatchObject({
    kind: "upload_only",
    rootNodeId: f.owner.ids.folder,
    actions: ["create", "upload"],
    reservedBytes: 0,
    reservationLimit: 1024 ** 3,
  });
  expect(await readShare(env.DB, f.session, created.id)).toMatchObject({
    kind: "upload_only",
    actions: ["create", "upload"],
    reservedBytes: 0,
    reservationLimit: 1024 ** 3,
  });
  expect(await listShares(env.DB, f.session)).toEqual([
    expect.objectContaining({
      id: created.id,
      kind: "upload_only",
      reservationLimit: 1024 ** 3,
    }),
  ]);
  await expect(
    createShare(mutationEnv(), f.session, {
      rootNodeId: f.owner.ids.file,
      spaceId: f.owner.ids.space,
      kind: "upload_only",
    }),
  ).rejects.toThrow("share_root_not_found");
  await expect(
    createShare(mutationEnv(), f.session, {
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      kind: "link",
      reservationLimitBytes: 1,
    }),
  ).rejects.toThrow("invalid_share_request");
});

it("disables idempotently, bumps the version once, and revokes derived state", async () => {
  const f = await fixture();
  const created = await createShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
  });
  const shareSessionId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO share_sessions(
        id,share_id,share_version,secret_digest,epoch,issued_at,expires_at
      ) VALUES(?,?,1,?,1,?,?)`,
      values: [shareSessionId, created.id, crypto.randomUUID(), Date.now(), Date.now() + 60_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [`ss:${shareSessionId}`, shareSessionId],
    },
  ]);
  await disableShare(mutationEnv(), f.session, created.id);
  await disableShare(mutationEnv(), f.session, created.id);
  expect(await readShare(env.DB, f.session, created.id)).toMatchObject({
    version: 2,
  });
  expect(
    await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
      .bind(created.id)
      .first("disabled_at"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT revoked_at FROM share_sessions WHERE id=?")
      .bind(shareSessionId)
      .first("revoked_at"),
  ).not.toBeNull();
  await expect(disableShare(mutationEnv(), f.otherSession, created.id)).rejects.toThrow(
    "share_not_found",
  );
});
