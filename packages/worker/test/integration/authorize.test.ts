import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  authorizationAssertion,
  authorizeNode,
  type NodeRequest,
  type Principal,
  servicePrincipal,
} from "../../src/auth/authorize";
import { atomicBatch } from "../../src/db/primary";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(kind: Principal["kind"] = "user") {
  const now = Date.now() - 1000;
  const owner = foundationFixture(crypto.randomUUID(), now);
  const other = foundationFixture(crypto.randomUUID(), now);
  await atomicBatch(env.DB, [...owner.statements, ...other.statements]);
  const ids = owner.ids;
  const credential = `${kind}:${ids.user}`;
  let principal: Principal = {
    kind: "user",
    credential_id: ids.credential,
    user_id: ids.user,
    epoch: 1,
  };
  if (kind === "app_password") {
    await atomicBatch(env.DB, [
      {
        sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
        VALUES(?,?,?,'test','digest','salt','PBKDF2-SHA256','{"iterations":100000}','k1',?,?)`,
        values: [credential, ids.user, ids.folder, now, now + 600000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
        values: [`ap:${credential}`, credential],
      },
      {
        sql: "INSERT INTO credential_scopes VALUES(?,'node:read'),(?,'node:create')",
        values: [`ap:${credential}`, `ap:${credential}`],
      },
    ]);
    principal = { kind, credential_id: `ap:${credential}`, user_id: ids.user, epoch: 1 };
  } else if (kind === "link_share") {
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
        values: [credential, ids.user, ids.folder, now],
      },
      {
        sql: "INSERT INTO share_actions VALUES(?,'read'),(?,'create')",
        values: [credential, credential],
      },
      {
        sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
        values: [credential, credential, credential, now, now + 600000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
        values: [`ss:${credential}`, credential],
      },
    ]);
    principal = {
      kind,
      credential_id: `ss:${credential}`,
      share_id: credential,
      share_version: 1,
      epoch: 1,
    };
  } else if (kind === "service") {
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO service_principals(id,access_iss,common_name,mapped_user_id,space_id,root_node_id) VALUES(?,'https://access.invalid',?,?,?,?)",
        values: [credential, credential, ids.user, ids.space, ids.folder],
      },
      {
        sql: "INSERT INTO credentials(id,kind,service_principal_id) VALUES(?,'service',?)",
        values: [`sv:${credential}`, credential],
      },
      { sql: "INSERT INTO credential_scopes VALUES(?,'node:read')", values: [`sv:${credential}`] },
    ]);
    principal = {
      kind,
      credential_id: `sv:${credential}`,
      service_principal_id: credential,
      user_id: ids.user,
      epoch: 1,
      token_expires_at: now + 600000,
      access_iss: "https://access.invalid",
      common_name: credential,
    };
  }
  const read: NodeRequest = {
    operation: kind === "service" ? "automation.metadata.read" : "node.read",
    nodeId: ids.file,
    spaceId: ids.space,
  };
  const create: NodeRequest = {
    operation: "node.create",
    parentId: ids.folder,
    spaceId: ids.space,
  };
  return { ids, other: other.ids, principal, read, create, credential, now };
}

it.each(["user", "app_password", "link_share", "service"] as const)(
  "authorizes %s from current D1 authority, never as a different actor or space",
  async (kind) => {
    const f = await fixture(kind);
    expect(await authorizeNode(env.DB, f.principal, f.read)).toMatchObject({
      operation: f.read.operation,
      node: { id: f.ids.file },
    });
    await expect(
      authorizeNode(env.DB, f.principal, { ...f.read, spaceId: f.other.space }),
    ).rejects.toThrow("authorization_denied");
    await expect(
      authorizeNode(env.DB, f.principal, {
        ...f.read,
        nodeId: f.other.file,
        spaceId: f.other.space,
      }),
    ).rejects.toThrow();
    if (kind === "service") {
      await expect(authorizeNode(env.DB, f.principal, f.create)).rejects.toThrow();
      await expect(
        authorizeNode(env.DB, f.principal, {
          operation: "node.rename",
          nodeId: f.ids.file,
          spaceId: f.ids.space,
        }),
      ).rejects.toThrow();
    } else {
      expect(await authorizeNode(env.DB, f.principal, f.create)).toMatchObject({
        operation: "node.create",
        parent: { id: f.ids.folder },
      });
    }
    if (f.principal.kind !== "link_share")
      await expect(
        authorizeNode(env.DB, { ...f.principal, user_id: f.other.user }, f.read),
      ).rejects.toThrow();
    await expect(
      authorizeNode(env.DB, { ...f.principal, credential_id: f.other.credential }, f.read),
    ).rejects.toThrow();
  },
);

it.each(["user", "app_password", "link_share"] as const)(
  "authorizes %s rename only for a live child with current edit authority",
  async (kind) => {
    const f = await fixture(kind);
    const rename: NodeRequest = {
      operation: "node.rename",
      nodeId: f.ids.file,
      spaceId: f.ids.space,
    };
    if (kind === "app_password") {
      await env.DB.prepare("INSERT INTO credential_scopes VALUES(?,'node:write')")
        .bind(f.principal.credential_id)
        .run();
    }
    if (kind === "link_share") {
      await env.DB.prepare("INSERT INTO share_actions VALUES(?,'edit')").bind(f.credential).run();
    }
    const proof = await authorizeNode(env.DB, f.principal, rename);
    expect(proof).toMatchObject({
      operation: "node.rename",
      node: { id: f.ids.file },
      parentId: f.ids.folder,
    });
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).resolves.toBeDefined();
    await expect(
      authorizeNode(env.DB, f.principal, { ...rename, nodeId: f.ids.root }),
    ).rejects.toThrow(/authorization_denied/);
    if (kind !== "user") {
      await expect(
        authorizeNode(env.DB, f.principal, { ...rename, nodeId: f.ids.folder }),
      ).rejects.toThrow(/authorization_denied/);
    } else {
      await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
        .bind(f.ids.root, f.ids.file)
        .run();
      await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
      await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
        .bind(f.ids.folder, f.ids.file)
        .run();
    }
    if (kind === "app_password") {
      await env.DB.prepare(
        "DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:write'",
      )
        .bind(f.principal.credential_id)
        .run();
    } else if (kind === "link_share") {
      await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='edit'")
        .bind(f.credential)
        .run();
    } else {
      await env.DB.prepare("UPDATE control SET maintenance=1").run();
    }
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  },
);

it.each(["user", "app_password", "link_share", "service"] as const)(
  "blocks a stale %s authorization in the actual mutation batch after credential revocation",
  async (kind) => {
    const f = await fixture(kind);
    const proof = await authorizeNode(env.DB, f.principal, f.read);
    const revocation =
      kind === "user"
        ? "UPDATE sessions SET revoked_at=1 WHERE id=?"
        : kind === "app_password"
          ? "UPDATE app_passwords SET revoked_at=1 WHERE id=?"
          : kind === "link_share"
            ? "UPDATE share_sessions SET revoked_at=1 WHERE id=?"
            : "UPDATE service_principals SET disabled_at=1 WHERE id=?";
    await env.DB.prepare(revocation)
      .bind(kind === "user" ? f.ids.session : f.credential)
      .run();
    await expect(
      atomicBatch(env.DB, [
        { sql: "UPDATE users SET used_bytes=99 WHERE id=?", values: [f.ids.user] },
        authorizationAssertion(proof),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT used_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("used_bytes"),
    ).toBe(3);
    await expect(authorizeNode(env.DB, f.principal, f.read)).rejects.toThrow();
  },
);

it.each(["user", "app_password", "link_share", "service"] as const)(
  "rejects %s after owner disable, ancestor trash, or epoch change",
  async (kind) => {
    const f = await fixture(kind);
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
    await expect(authorizeNode(env.DB, f.principal, f.read)).rejects.toThrow();
    await env.DB.prepare("UPDATE users SET disabled_at=NULL WHERE id=?").bind(f.ids.user).run();
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',?,1)",
        values: [f.credential, f.ids.user, f.ids.space, f.ids.folder, f.now],
      },
      {
        sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
        values: [f.now, f.credential, f.ids.folder],
      },
    ]);
    await expect(authorizeNode(env.DB, f.principal, f.read)).rejects.toThrow();
    await env.DB.prepare("UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL WHERE id=?")
      .bind(f.ids.folder)
      .run();
    await env.DB.prepare("UPDATE control SET epoch=2").run();
    await expect(authorizeNode(env.DB, f.principal, f.read)).rejects.toThrow();
  },
);

it.each(["user", "app_password", "link_share"] as const)(
  "rejects an expired %s credential at commit using D1 time",
  async (kind) => {
    const f = await fixture(kind);
    const proof = await authorizeNode(env.DB, f.principal, f.read);
    const sql =
      kind === "user"
        ? "UPDATE sessions SET expires_at=issued_at+1 WHERE id=?"
        : kind === "app_password"
          ? "UPDATE app_passwords SET expires_at=created_at+1 WHERE id=?"
          : "UPDATE share_sessions SET expires_at=issued_at+1 WHERE id=?";
    await env.DB.prepare(sql)
      .bind(kind === "user" ? f.ids.session : f.credential)
      .run();
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  },
);

it.each(["app_password", "link_share", "service"] as const)(
  "invalidates %s scope when a node moves outside the credential root",
  async (kind) => {
    const f = await fixture(kind);
    const proof = await authorizeNode(env.DB, f.principal, f.read);
    await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
      .bind(f.ids.root, f.ids.file)
      .run();
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  },
);

it.each(["app_password", "service"] as const)(
  "intersects %s scopes and root even when the mapped user is app_admin",
  async (kind) => {
    const f = await fixture(kind);
    await expect(
      authorizeNode(env.DB, f.principal, { ...f.read, nodeId: f.ids.root }),
    ).rejects.toThrow();
    const proof = await authorizeNode(env.DB, f.principal, f.read);
    await env.DB.prepare(
      "DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:read'",
    )
      .bind(f.principal.credential_id)
      .run();
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
    await expect(authorizeNode(env.DB, f.principal, f.read)).rejects.toThrow();
  },
);

it.each(["version", "expiry", "action", "upload-only"])(
  "rejects link share %s changes and cannot escape its root",
  async (condition) => {
    const f = await fixture("link_share");
    await expect(
      authorizeNode(env.DB, f.principal, { ...f.read, nodeId: f.ids.root }),
    ).rejects.toThrow();
    const proof = await authorizeNode(env.DB, f.principal, f.read);
    const sql =
      condition === "version"
        ? "UPDATE shares SET version=version+1 WHERE id=?"
        : condition === "expiry"
          ? "UPDATE shares SET expires_at=1 WHERE id=?"
          : condition === "action"
            ? "DELETE FROM share_actions WHERE share_id=? AND action='read'"
            : "UPDATE shares SET kind='upload_only' WHERE id=?";
    await env.DB.prepare(sql).bind(f.credential).run();
    await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  },
);

it("requires a current internal grant for a different owner's node and rechecks it at commit", async () => {
  const f = await fixture();
  const request: NodeRequest = {
    operation: "node.read",
    nodeId: f.other.file,
    spaceId: f.other.space,
  };
  await expect(authorizeNode(env.DB, f.principal, request)).rejects.toThrow();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [f.credential, f.other.user, f.other.folder, f.now],
    },
    { sql: "INSERT INTO share_actions VALUES(?,'read')", values: [f.credential] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [f.credential, f.ids.user],
    },
  ]);
  const proof = await authorizeNode(env.DB, f.principal, request);
  const rename: NodeRequest = { ...request, operation: "node.rename" };
  await expect(authorizeNode(env.DB, f.principal, rename)).rejects.toThrow();
  await env.DB.prepare("INSERT INTO share_actions VALUES(?,'edit')").bind(f.credential).run();
  const renameProof = await authorizeNode(env.DB, f.principal, rename);
  await expect(
    authorizeNode(env.DB, f.principal, { ...rename, nodeId: f.other.folder }),
  ).rejects.toThrow();
  await expect(
    authorizeNode(env.DB, f.principal, {
      operation: "node.create",
      parentId: f.other.folder,
      spaceId: f.other.space,
    }),
  ).rejects.toThrow();
  await expect(
    authorizeNode(env.DB, f.principal, { ...request, nodeId: f.other.root }),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE share_grants SET disabled_at=1 WHERE share_id=?")
    .bind(f.credential)
    .run();
  await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  await expect(atomicBatch(env.DB, [authorizationAssertion(renameProof)])).rejects.toThrow();
  await env.DB.prepare("UPDATE share_grants SET disabled_at=NULL,version=2 WHERE share_id=?")
    .bind(f.credential)
    .run();
  await expect(authorizeNode(env.DB, f.principal, request)).rejects.toThrow();
});

it("binds a create proof to its parent revision, tree generation and maintenance state", async () => {
  const f = await fixture();
  await expect(
    authorizeNode(env.DB, f.principal, { ...f.create, parentId: f.ids.file }),
  ).rejects.toThrow();
  const proof = await authorizeNode(env.DB, f.principal, f.create);
  await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).resolves.toBeDefined();
  await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?").bind(f.ids.folder).run();
  await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
  const newer = await authorizeNode(env.DB, f.principal, f.create);
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(f.ids.space)
    .run();
  await expect(atomicBatch(env.DB, [authorizationAssertion(newer)])).rejects.toThrow();
  const newest = await authorizeNode(env.DB, f.principal, f.create);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(atomicBatch(env.DB, [authorizationAssertion(newest)])).rejects.toThrow();
  expect(() => authorizationAssertion({ ...newest })).toThrow("invalid_authorization_proof");
});

it("proves a depth-64 read but refuses a create below it", async () => {
  const f = await fixture();
  let parent = f.ids.root;
  const statements = [];
  for (let i = 1; i <= 64; i++) {
    const id = `${f.ids.user}-depth-${i}`;
    statements.push({
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',?,?)",
      values: [id, f.ids.space, f.ids.user, parent, `d${i}`, `d${i}`, f.now, f.now],
    });
    parent = id;
  }
  await atomicBatch(env.DB, statements);
  await expect(
    authorizeNode(env.DB, f.principal, {
      operation: "node.read",
      nodeId: parent,
      spaceId: f.ids.space,
    }),
  ).resolves.toBeDefined();
  await expect(
    authorizeNode(env.DB, f.principal, {
      operation: "node.create",
      parentId: parent,
      spaceId: f.ids.space,
    }),
  ).rejects.toThrow();
});

it("maps only a verified service identity and denies expired tokens or an ordinary user operation", async () => {
  const f = await fixture("service");
  const access = await accessFixture();
  const claims = await access.verifier.verify(
    await access.sign({ aud: "service-aud", sub: "", email: undefined, common_name: f.credential }),
    "service",
  );
  const principal = await servicePrincipal(env.DB, claims, 1);
  await expect(authorizeNode(env.DB, principal, f.read)).resolves.toBeDefined();
  await expect(
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.ids.file,
      spaceId: f.ids.space,
    }),
  ).rejects.toThrow();
  await expect(
    servicePrincipal(env.DB, { ...claims, common_name: "unmapped" }, 1),
  ).rejects.toThrow();
  if (principal.kind !== "service") throw new Error("invalid_principal");
  await expect(
    authorizeNode(env.DB, { ...principal, token_expires_at: 1 }, f.read),
  ).rejects.toThrow();
  const proof = await authorizeNode(env.DB, principal, f.read);
  await env.DB.prepare("UPDATE service_principals SET common_name='replacement-'||id WHERE id=?")
    .bind(f.credential)
    .run();
  await expect(atomicBatch(env.DB, [authorizationAssertion(proof)])).rejects.toThrow();
});

it("never accepts a job/system principal as user read authority without its dedicated claim checks", async () => {
  const f = await fixture();
  for (const kind of ["job", "system"])
    await expect(
      authorizeNode(env.DB, { ...f.principal, kind } as unknown as Principal, f.read),
    ).rejects.toThrow();
});
