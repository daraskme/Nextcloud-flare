import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { groupRoute, handleGroupHttp } from "../../src/api/groups";
import { handleShareHttp } from "../../src/api/shares";
import { authorizationAssertion, authorizeNode } from "../../src/auth/authorize";
import { contentSessionAssertion } from "../../src/auth/contentSession";
import { readAccessSession } from "../../src/auth/sessions";
import {
  davReadAssertion,
  parseDavPath,
  resolveDavCreateParent,
  resolveDavMoveNode,
  resolveDavNode,
  resolveDavPropsNode,
  resolveDavTransferDestination,
} from "../../src/dav/path";
import { atomicBatch } from "../../src/db/primary";
import { ensureContentBudget } from "../../src/services/contentBudget";
import {
  createShareGroup,
  disableShareGroup,
  listShareGroups,
  readShareGroup,
  updateShareGroup,
} from "../../src/services/groups";
import {
  createInternalShare,
  disableShare,
  listSharedWithMe,
  readShare,
  updateInternalShareActions,
} from "../../src/services/shares";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

async function sharingFixture() {
  const now = Date.now() - 1000;
  const owner = foundationFixture(crypto.randomUUID(), now);
  const member = foundationFixture(crypto.randomUUID(), now);
  const outsider = foundationFixture(crypto.randomUUID(), now);
  const disabled = foundationFixture(crypto.randomUUID(), now);
  const suffix = owner.ids.user.slice(0, 8);
  const ownerEmail = `group-owner-${suffix}@example.invalid`;
  const memberEmail = `group-member-${suffix}@example.invalid`;
  const outsiderEmail = `group-outsider-${suffix}@example.invalid`;
  const disabledEmail = `group-disabled-${suffix}@example.invalid`;
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...member.statements,
    ...outsider.statements,
    ...disabled.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [ownerEmail, owner.ids.user],
    },
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [memberEmail, member.ids.user],
    },
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [outsiderEmail, outsider.ids.user],
    },
    {
      sql: "UPDATE users SET email=?,disabled_at=? WHERE id=?",
      values: [disabledEmail, Date.now(), disabled.ids.user],
    },
  ]);
  const ownerSession = await readAccessSession(env.DB, owner.ids.credential, 1);
  const memberSession = await readAccessSession(env.DB, member.ids.credential, 1);
  const outsiderSession = await readAccessSession(env.DB, outsider.ids.credential, 1);
  if (!ownerSession || !memberSession || !outsiderSession)
    throw new Error("fixture_session_missing");
  return {
    owner,
    member,
    outsider,
    ownerSession,
    memberSession,
    outsiderSession,
    ownerEmail,
    memberEmail,
    outsiderEmail,
    disabledEmail,
  };
}

async function createGroupShare(f: Awaited<ReturnType<typeof sharingFixture>>) {
  const group = await createShareGroup(mutationEnv(), f.ownerSession, {
    name: "Engineering",
    memberEmails: [f.memberEmail],
  });
  const share = await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientGroupId: group.id,
    actions: ["read", "download"],
  });
  return { group, share };
}

async function appPrincipal(userId: string) {
  const appId = crypto.randomUUID();
  const credentialId = `ap:${appId}`;
  const now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO app_passwords(
        id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at
      ) VALUES(?,?,'group DAV','digest','salt','PBKDF2-SHA256','{"iterations":100000}','k1',?,?)`,
      values: [appId, userId, now, now + 600_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [credentialId, appId],
    },
    {
      sql: `INSERT INTO credential_scopes(credential_id,scope)
        VALUES(?,'node:read'),(?,'node:create'),(?,'node:write'),(?,'node:delete')`,
      values: [credentialId, credentialId, credentialId, credentialId],
    },
  ]);
  return {
    kind: "app_password" as const,
    user_id: userId,
    credential_id: credentialId,
    epoch: 1,
  };
}

it("owns bounded group lifecycle and rejects cross-owner or inactive membership", async () => {
  const f = await sharingFixture();
  const group = await createShareGroup(mutationEnv(), f.ownerSession, {
    name: "Engineering",
    memberEmails: [f.memberEmail],
  });
  expect(group).toMatchObject({
    name: "Engineering",
    version: 1,
    memberEmails: [f.memberEmail],
  });
  await expect(listShareGroups(env.DB, f.ownerSession)).resolves.toEqual([group]);
  await expect(readShareGroup(env.DB, f.ownerSession, group.id)).resolves.toEqual(group);
  await expect(readShareGroup(env.DB, f.outsiderSession, group.id)).rejects.toThrow(
    "group_not_found",
  );
  await expect(
    updateShareGroup(mutationEnv(), f.outsiderSession, group.id, { name: "Stolen" }),
  ).rejects.toThrow("group_not_found");
  await expect(disableShareGroup(mutationEnv(), f.outsiderSession, group.id)).rejects.toThrow(
    "group_not_found",
  );
  await expect(
    createShareGroup(mutationEnv(), f.ownerSession, {
      name: "engineering",
      memberEmails: [],
    }),
  ).rejects.toThrow("group_exists");
  await expect(
    createShareGroup(mutationEnv(), f.ownerSession, {
      name: "Disabled",
      memberEmails: [f.disabledEmail],
    }),
  ).rejects.toThrow("group_member_not_found");
  await expect(
    createShareGroup(mutationEnv(), f.ownerSession, {
      name: "Too many members",
      memberEmails: Array.from({ length: 101 }, (_, index) => `member-${index}@example.invalid`),
    }),
  ).rejects.toThrow("invalid_group_request");
  await expect(
    createInternalShare(mutationEnv(), f.outsiderSession, {
      rootNodeId: f.outsider.ids.folder,
      spaceId: f.outsider.ids.space,
      recipientGroupId: group.id,
      actions: ["read"],
    }),
  ).rejects.toThrow("share_recipient_not_found");
  await expect(
    createInternalShare(mutationEnv(), f.memberSession, {
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      recipientEmail: f.outsiderEmail,
      actions: ["read"],
    }),
  ).rejects.toThrow("share_root_not_found");

  await env.DB.prepare(
    `WITH RECURSIVE seq(value) AS (
      SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<99
    )
    INSERT INTO share_groups(id,owner_id,name,name_ci,created_at,updated_at)
    SELECT 'group-limit-'||value,?,'Limit '||value,'limit '||value,?,? FROM seq`,
  )
    .bind(f.owner.ids.user, Date.now(), Date.now())
    .run();
  await expect(
    createShareGroup(mutationEnv(), f.ownerSession, {
      name: "Overflow",
      memberEmails: [],
    }),
  ).rejects.toThrow("group_limit");
});

it("keeps group mounts stable and fences DAV action, version, ancestry, epoch and writes", async () => {
  const f = await sharingFixture();
  const { group, share } = await createGroupShare(f);
  if (!share.mountName) throw new Error("fixture_mount_missing");
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([
    expect.objectContaining({
      shareId: share.id,
      mountName: share.mountName,
      provenance: {
        kind: "group",
        groupId: expect.any(String),
        groupName: "Engineering",
        groupVersion: 1,
        membershipVersion: 1,
      },
    }),
  ]);
  expect(await listSharedWithMe(env.DB, f.outsiderSession)).toEqual([]);
  expect(await readShare(env.DB, f.ownerSession, share.id)).toMatchObject({
    recipientGroupId: expect.any(String),
    recipientGroupName: "Engineering",
    recipientUserId: null,
  });
  await env.DB.prepare(
    "UPDATE nodes SET name='Renamed',name_ci='renamed',revision=revision+1 WHERE id=?",
  )
    .bind(f.owner.ids.folder)
    .run();
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([
    expect.objectContaining({
      shareId: share.id,
      mountName: share.mountName,
      root: expect.objectContaining({ name: "Renamed" }),
    }),
  ]);

  const principal = await appPrincipal(f.member.ids.user);
  const path = parseDavPath(`/dav/Shared/${encodeURIComponent(share.mountName)}/File`);
  const proof = await resolveDavNode(env.DB, principal, path, "download");
  expect(proof.node.id).toBe(f.owner.ids.file);
  await expect(resolveDavPropsNode(env.DB, principal, path)).rejects.toThrow(
    "dav_node_unavailable",
  );
  await expect(resolveDavMoveNode(env.DB, principal, path)).rejects.toThrow("dav_node_unavailable");
  const sharedRoot = parseDavPath(`/dav/Shared/${encodeURIComponent(share.mountName)}`);
  await expect(resolveDavCreateParent(env.DB, principal, sharedRoot)).rejects.toThrow(
    "dav_node_unavailable",
  );
  await expect(
    resolveDavTransferDestination(
      env.DB,
      principal,
      parseDavPath(`/dav/Shared/${encodeURIComponent(share.mountName)}/Copied`),
    ),
  ).rejects.toThrow("dav_node_unavailable");

  await updateInternalShareActions(mutationEnv(), f.ownerSession, share.id, [
    "read",
    "download",
    "create",
    "edit",
  ]);
  const writable = await resolveDavPropsNode(env.DB, principal, path);
  expect(writable.principal).toMatchObject({
    internal_share: {
      share_id: share.id,
      recipient: {
        kind: "group",
        group_id: group.id,
        membership_version: 1,
      },
    },
  });
  await expect(resolveDavCreateParent(env.DB, principal, sharedRoot)).resolves.toBeDefined();
  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, { memberEmails: [] });
  await expect(atomicBatch(env.DB, [authorizationAssertion(writable)])).rejects.toThrow();
  await expect(resolveDavPropsNode(env.DB, principal, path)).rejects.toThrow(
    "dav_node_unavailable",
  );
  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, {
    memberEmails: [f.memberEmail],
  });
  expect((await resolveDavPropsNode(env.DB, principal, path)).principal).toMatchObject({
    internal_share: { recipient: { kind: "group", membership_version: 2 } },
  });
  await updateInternalShareActions(mutationEnv(), f.ownerSession, share.id, ["read", "download"]);
  await expect(
    atomicBatch(env.DB, [authorizationAssertion(proof), davReadAssertion(proof)]),
  ).rejects.toThrow();
  await expect(resolveDavNode(env.DB, principal, path, "download")).resolves.toBeDefined();

  const trashOp = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO trash_ops(
        op_id,actor_id,space_id,root_node_id,state,created_at,epoch
      ) VALUES(?,?,?,?,'trashed',?,1)`,
      values: [trashOp, f.owner.ids.user, f.owner.ids.space, f.owner.ids.folder, Date.now()],
    },
    {
      sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
      values: [Date.now(), trashOp, f.owner.ids.folder],
    },
  ]);
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([]);
  await expect(resolveDavNode(env.DB, principal, path)).rejects.toThrow("dav_node_unavailable");
  await env.DB.prepare("UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL WHERE id=?")
    .bind(f.owner.ids.folder)
    .run();
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await expect(resolveDavNode(env.DB, principal, path)).rejects.toThrow("dav_node_unavailable");
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=2 WHERE singleton=1").run();
  await expect(resolveDavNode(env.DB, principal, path)).rejects.toThrow("dav_node_unavailable");
});

it("revokes removed members immediately and never revives stale content sessions", async () => {
  const f = await sharingFixture();
  const { group, share } = await createGroupShare(f);
  if (!share.mountName) throw new Error("fixture_mount_missing");
  const principal = {
    kind: "user" as const,
    user_id: f.member.ids.user,
    credential_id: f.member.ids.credential,
    epoch: 1,
  };
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.read",
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  });
  const expiresAt = Date.now() + 300_000;
  const oldBudget = await ensureContentBudget(mutationEnv(), authorized, expiresAt, {
    id: share.id,
    version: share.version,
  });
  expect(oldBudget.id).toBe(`u:${f.member.ids.user}:s:${share.id}:v:1:m:1`);

  const targetId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const contentId = crypto.randomUUID();
  const now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO target_sets(
        id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch
      ) VALUES(?,?,?,'${"0".repeat(64)}','group-target',0,?,1)`,
      values: [targetId, f.owner.ids.user, f.member.ids.credential, expiresAt],
    },
    {
      sql: `INSERT INTO tickets(
        id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at
      ) VALUES(?,?,?,?,'content',1,?,?)`,
      values: [ticketId, f.member.ids.credential, targetId, oldBudget.id, now, expiresAt],
    },
    {
      sql: `INSERT INTO content_sessions(
        id,user_id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,
        ticket_id,epoch,issued_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
      values: [
        contentId,
        f.member.ids.user,
        share.id,
        share.version,
        f.member.ids.credential,
        targetId,
        oldBudget.id,
        ticketId,
        now,
        expiresAt,
      ],
    },
  ]);
  const contentAssertion = () =>
    atomicBatch(env.DB, [
      contentSessionAssertion(principal, contentId, ticketId, "content", {
        id: share.id,
        version: share.version,
      }),
    ]);
  await contentAssertion();
  const davPrincipal = await appPrincipal(f.member.ids.user);
  const davPath = parseDavPath(`/dav/Shared/${encodeURIComponent(share.mountName)}/File`);
  const davProof = await resolveDavNode(env.DB, davPrincipal, davPath);

  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, { memberEmails: [] });
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([]);
  await expect(
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.owner.ids.file,
      spaceId: f.owner.ids.space,
    }),
  ).rejects.toThrow("authorization_denied");
  await expect(resolveDavNode(env.DB, davPrincipal, davPath)).rejects.toThrow(
    "dav_node_unavailable",
  );
  await expect(
    atomicBatch(env.DB, [authorizationAssertion(davProof), davReadAssertion(davProof)]),
  ).rejects.toThrow();
  await expect(contentAssertion()).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT revoked_at FROM content_sessions WHERE id=?")
      .bind(contentId)
      .first<number>("revoked_at"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(oldBudget.id)
      .first<string>("state"),
  ).toBe("revoked");

  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, {
    memberEmails: [f.memberEmail],
  });
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([
    expect.objectContaining({
      provenance: expect.objectContaining({ kind: "group", membershipVersion: 2 }),
    }),
  ]);
  await expect(contentAssertion()).rejects.toThrow();
  const membershipVersion = await env.DB.prepare(
    "SELECT version FROM share_group_members WHERE group_id=? AND user_id=?",
  )
    .bind(group.id, f.member.ids.user)
    .first<number>("version");
  expect(membershipVersion).toBe(2);
  const reauthorized = await authorizeNode(env.DB, principal, {
    operation: "node.read",
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  });
  const newBudget = await ensureContentBudget(mutationEnv(), reauthorized, expiresAt, {
    id: share.id,
    version: share.version,
  });
  expect(newBudget.id).toBe(`u:${f.member.ids.user}:s:${share.id}:v:1:m:2`);
  expect(newBudget.id).not.toBe(oldBudget.id);

  await disableShareGroup(mutationEnv(), f.ownerSession, group.id);
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([]);
  await expect(readShareGroup(env.DB, f.ownerSession, group.id)).rejects.toThrow("group_not_found");
  expect(
    await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
      .bind(share.id)
      .first<number>("disabled_at"),
  ).not.toBeNull();
});

it("rotates group-share budgets when share actions change", async () => {
  const f = await sharingFixture();
  const { share } = await createGroupShare(f);
  const principal = {
    kind: "user" as const,
    user_id: f.member.ids.user,
    credential_id: f.member.ids.credential,
    epoch: 1,
  };
  const authorize = () =>
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.owner.ids.file,
      spaceId: f.owner.ids.space,
    });
  const expiresAt = Date.now() + 300_000;
  const oldBudget = await ensureContentBudget(mutationEnv(), await authorize(), expiresAt, {
    id: share.id,
    version: share.version,
  });

  const updated = await updateInternalShareActions(mutationEnv(), f.ownerSession, share.id, [
    "read",
    "download",
    "create",
  ]);
  expect(
    await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(oldBudget.id)
      .first<string>("state"),
  ).toBe("revoked");

  const newBudget = await ensureContentBudget(mutationEnv(), await authorize(), expiresAt, {
    id: updated.id,
    version: updated.version,
  });
  expect(newBudget.id).toBe(`u:${f.member.ids.user}:s:${share.id}:v:2:m:1`);
  expect(newBudget.id).not.toBe(oldBudget.id);
  expect(
    await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(newBudget.id)
      .first<string>("state"),
  ).toBe("active");
});

it("serves the owner group lifecycle through private JSON and CSRF routes", async () => {
  const f = await sharingFixture();
  const csrf = { verify: vi.fn(async () => undefined) };
  const serviceEnv = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const create = new Request("https://app.invalid/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "API Team",
      memberEmails: [f.memberEmail],
    }),
  });
  expect(groupRoute(create)).toBe(true);
  const createdResponse = await handleGroupHttp(create, serviceEnv, f.ownerSession, csrf);
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as { id: string };
  const shared = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "internal",
        rootNodeId: f.owner.ids.folder,
        spaceId: f.owner.ids.space,
        recipientGroupId: created.id,
        actions: ["read"],
      }),
    }),
    serviceEnv,
    f.ownerSession,
    csrf,
  );
  expect(shared.status).toBe(201);
  const listed = await handleGroupHttp(
    new Request("https://app.invalid/api/v1/groups"),
    serviceEnv,
    f.ownerSession,
    csrf,
  );
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toEqual({
    groups: [expect.objectContaining({ id: created.id, name: "API Team" })],
  });
  const updated = await handleGroupHttp(
    new Request(`https://app.invalid/api/v1/groups/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "API Team Renamed", memberEmails: [] }),
    }),
    serviceEnv,
    f.ownerSession,
    csrf,
  );
  expect(updated.status).toBe(200);
  await expect(updated.json()).resolves.toEqual(
    expect.objectContaining({ name: "API Team Renamed", memberEmails: [] }),
  );
  const disabled = await handleGroupHttp(
    new Request(`https://app.invalid/api/v1/groups/${created.id}`, { method: "DELETE" }),
    serviceEnv,
    f.ownerSession,
    csrf,
  );
  expect(disabled.status).toBe(204);
  expect(csrf.verify).toHaveBeenCalledTimes(4);
});

it("keeps direct-user sharing intact beside group grants", async () => {
  const f = await sharingFixture();
  const direct = await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.memberEmail,
    actions: ["read"],
  });
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([
    expect.objectContaining({
      shareId: direct.id,
      provenance: { kind: "direct", recipientVersion: 1 },
    }),
  ]);
  await disableShare(mutationEnv(), f.ownerSession, direct.id);
  expect(await listSharedWithMe(env.DB, f.memberSession)).toEqual([]);
});
