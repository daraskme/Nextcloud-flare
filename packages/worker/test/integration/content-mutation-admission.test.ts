import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { handlePrivateContentTicketHttp } from "../../src/api/contentTickets";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { ensureContentBudget } from "../../src/services/contentBudget";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";

const actions = ["budget", "issue", "accept", "cancel"] as const;
type Action = (typeof actions)[number];
type Identity = "owner" | "app" | "internal" | "anonymous";
const objectKeys = new Set<string>();
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(async () => {
  if (objectKeys.size) await env.BLOBS.delete([...objectKeys]);
  objectKeys.clear();
});
const matches = (request: MutationRequest, action: Action) =>
  request.permitId.startsWith("content." + action + ":");
const writes = (sql: string, action: Action) =>
  sql.includes(
    {
      budget: "INSERT INTO budgets",
      issue: "INSERT INTO target_sets",
      accept: "INSERT INTO content_sessions",
      cancel: "UPDATE tickets SET cancelled_at",
    }[action],
  );

function database(options: {
  action: Action;
  before?: (statements: D1PreparedStatement[]) => Promise<void>;
  after?: () => Promise<void>;
  failReceiptRead?: boolean;
  rollback?: boolean;
}) {
  const queries = new WeakMap<object, string>();
  let calls = 0,
    committed = false;
  const db = {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      const wrap = (target: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(target, {
          get(object, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(object.bind(...values));
            if (
              key === "first" &&
              options.failReceiptRead &&
              committed &&
              sql.includes("committed_at IS NOT NULL")
            )
              return async () => {
                throw new Error("receipt_read_lost");
              };
            const value = Reflect.get(object, key);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
        queries.set(proxy, sql);
        return proxy;
      };
      return wrap(statement);
    },
    async batch(statements: D1PreparedStatement[]) {
      const domain = statements.some((s) => writes(queries.get(s) ?? "", options.action));
      if (domain) {
        calls++;
        await options.before?.(statements);
      }
      const result = await env.DB.batch(
        domain && options.rollback
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (domain) {
        committed = true;
        await options.after?.();
      }
      return result;
    },
  } as unknown as D1Database;
  return { db, calls: () => calls };
}

async function fixture(identity: Identity = "owner") {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = "u/" + f.ids.user + "/b/" + f.ids.blob;
  objectKeys.add(key);
  const object = (await env.BLOBS.put(key, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, object.etag, now)
    .run();
  const bucket = new Proxy(env.BLOBS, {
    get(target, field) {
      if (field === "put")
        return async (key: string, ...args: unknown[]) => {
          objectKeys.add(key);
          return Reflect.apply(target.put, target, [key, ...args]);
        };
      const value = Reflect.get(target, field);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  let share: { id: string; version: number } | undefined;
  let credentialTable = "sessions",
    credentialRow: string = f.ids.session;
  let recipientSpace: string | undefined;
  if (identity === "app") {
    const id = crypto.randomUUID(),
      credential = "ap:" + id;
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at) VALUES(?,?,?,'fixture','digest','salt','PBKDF2-SHA256',json_object('iterations',100000),'test',?,?)",
        values: [id, f.ids.user, f.ids.folder, now, now + 500000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
        values: [credential, id],
      },
      { sql: "INSERT INTO credential_scopes VALUES(?,'node:read')", values: [credential] },
    ]);
    principal = { kind: "app_password", user_id: f.ids.user, credential_id: credential, epoch: 1 };
    credentialTable = "app_passwords";
    credentialRow = id;
  }
  if (identity === "internal" || identity === "anonymous") {
    const id = crypto.randomUUID();
    share = { id, version: 1 };
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,?,?)",
        values: [id, f.ids.user, f.ids.folder, identity === "internal" ? "internal" : "link", now],
      },
      { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [id] },
    ]);
    if (identity === "internal") {
      const recipient = foundationFixture(crypto.randomUUID(), now - 1000);
      await atomicBatch(env.DB, recipient.statements);
      await env.DB.prepare("INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)")
        .bind(id, recipient.ids.user)
        .run();
      principal = {
        kind: "user",
        user_id: recipient.ids.user,
        credential_id: recipient.ids.credential,
        epoch: 1,
      };
      credentialRow = recipient.ids.session;
      recipientSpace = recipient.ids.space;
    } else {
      const unlock = crypto.randomUUID(),
        credential = "ss:" + unlock;
      await atomicBatch(env.DB, [
        {
          sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
          values: [unlock, id, "digest-" + unlock, now, now + 500000],
        },
        {
          sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
          values: [credential, unlock],
        },
      ]);
      principal = {
        kind: "link_share",
        share_id: id,
        share_version: 1,
        credential_id: credential,
        epoch: 1,
      };
      credentialTable = "share_sessions";
      credentialRow = unlock;
    }
  }
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ring, ring, "https://content.invalid");
  const target = { spaceId: f.ids.space, nodeId: f.ids.file };
  const expiresAt = now + 300000;
  const selected = identity === "internal" ? share : undefined;
  const issued = await issueContentTicket(
    mutationEnv(),
    bucket,
    tokens,
    principal,
    [target],
    "content",
    expiresAt,
    selected,
  );
  const accepted = await acceptContentTicket(mutationEnv(), tokens, issued.ticket);
  const proof = await authorizeNode(env.DB, principal, { operation: "node.read", ...target });
  const baseline = await env.DB.prepare(
    "SELECT MAX(seq) AS n FROM mutation_admissions",
  ).first<number>("n");
  const app = (acquire = (r: MutationRequest) => acquireMutation(r), db = env.DB): Env => ({
    ...mutationEnv(db),
    BLOBS: bucket,
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ acquireMutation: acquire }),
    } as unknown as Env["CONTROL"],
  });
  const run = (action: Action, configured = app()) =>
    action === "budget"
      ? ensureContentBudget(configured, proof, expiresAt + 1000, selected)
      : action === "issue"
        ? issueContentTicket(
            configured,
            bucket,
            tokens,
            principal,
            [target],
            "content",
            expiresAt,
            selected,
          )
        : action === "accept"
          ? acceptContentTicket(configured, tokens, issued.ticket)
          : cancelContentTicket(configured, principal, issued.ticketId);
  const rows = (action: Action) =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id FROM mutation_admissions WHERE seq>? AND space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(baseline, f.ids.space, "content." + action + ":%")
      .all()
      .then((r) => r.results);
  const snapshot = async () =>
    Promise.all([
      env.DB.prepare("SELECT * FROM budgets WHERE owner_id=? ORDER BY id").bind(f.ids.user).all(),
      env.DB.prepare("SELECT * FROM target_sets WHERE owner_id=? ORDER BY id")
        .bind(f.ids.user)
        .all(),
      env.DB.prepare(
        "SELECT t.* FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id WHERE ts.owner_id=? ORDER BY t.id",
      )
        .bind(f.ids.user)
        .all(),
      env.DB.prepare("SELECT * FROM content_sessions WHERE issued_by_credential_id=? ORDER BY id")
        .bind(principal.credential_id)
        .all(),
    ]).then((results) => results.map((r) => r.results));
  const revoke = () =>
    env.DB.prepare("UPDATE " + credentialTable + " SET revoked_at=1 WHERE id=?")
      .bind(credentialRow)
      .run();
  return {
    f,
    principal,
    share,
    recipientSpace,
    credentialRow,
    tokens,
    target,
    issued,
    accepted,
    expiresAt,
    app,
    run,
    rows,
    snapshot,
    revoke,
  };
}

it.each(
  (["owner", "app", "internal", "anonymous"] as const).flatMap((identity) =>
    actions.map((action) => ({ identity, action })),
  ),
)(
  "commits $action for $identity under the content owner's capacity and keeps one identity budget",
  async ({ identity, action }) => {
    const f = await fixture(identity);
    await f.run(
      action,
      f.app(async (r) => {
        expect(r.spaceId).toBe(f.f.ids.space);
        if (f.recipientSpace) expect(r.spaceId).not.toBe(f.recipientSpace);
        return acquireMutation(r);
      }),
    );
    expect(await f.rows(action)).toEqual([
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM budgets WHERE owner_id=?")
        .bind(f.f.ids.user)
        .first("n"),
    ).toBe(1);
    const receipts = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM mutation_admissions WHERE space_id=?")
          .bind(f.f.ids.space)
          .all()
      ).results,
    );
    expect(receipts).not.toContain(f.issued.ticket);
    expect(receipts).not.toContain(f.accepted.setCookie);
  },
);
it.each(actions)("rejects overloaded %s without domain changes", async (action) => {
  const f = await fixture(),
    before = await f.snapshot();
  await expect(
    f.run(
      action,
      f.app(async (r) => {
        if (matches(r, action)) throw new Error("full");
        return acquireMutation(r);
      }),
    ),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.snapshot()).toEqual(before);
  expect(await f.rows(action)).toEqual([]);
});
it.each(actions)(
  "recovers the exact %s receipt after a lost commit acknowledgement",
  async (action) => {
    const f = await fixture();
    const fault = database({
      action,
      after: async () => {
        throw new Error("lost_ack");
      },
    });
    await f.run(action, f.app(undefined, fault.db));
    expect(fault.calls()).toBe(1);
    expect(await f.rows(action)).toEqual([
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
  },
);
it.each(actions)("rolls back %s and its receipt together", async (action) => {
  const f = await fixture(),
    before = await f.snapshot(),
    fault = database({ action, rollback: true });
  await expect(f.run(action, f.app(undefined, fault.db))).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect(fault.calls()).toBe(1);
  expect(await f.rows(action)).toEqual([
    {
      state: action === "issue" ? "closed" : "active",
      committed_at: null,
      space_id: f.f.ids.space,
    },
  ]);
});
it.each(actions)("fences %s when maintenance starts during admission", async (action) => {
  const f = await fixture(),
    before = await f.snapshot();
  await expect(
    f.run(
      action,
      f.app(async (r) => {
        const a = await acquireMutation(r);
        if (matches(r, action)) await env.DB.prepare("UPDATE control SET maintenance=1").run();
        return a;
      }),
    ),
  ).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect(await f.rows(action)).toEqual([
    { state: "closed", committed_at: null, space_id: f.f.ids.space },
  ]);
});
it.each(actions)("rechecks the credential after %s waits for capacity", async (action) => {
  const f = await fixture(),
    before = await f.snapshot();
  await expect(
    f.run(
      action,
      f.app(async (r) => {
        const a = await acquireMutation(r);
        if (matches(r, action)) await f.revoke();
        return a;
      }),
    ),
  ).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect((await f.rows(action))[0]!.committed_at).toBeNull();
});
it.each(actions)(
  "rejects a mismatched owner grant for %s without publishing any result",
  async (action) => {
    const f = await fixture(),
      other = await fixture(),
      before = await f.snapshot();
    await expect(
      f.run(
        action,
        f.app((r) =>
          acquireMutation(matches(r, action) ? { ...r, spaceId: other.f.ids.space } : r),
        ),
      ),
    ).rejects.toBeInstanceOf(MutationUnavailableError);
    expect(await f.snapshot()).toEqual(before);
  },
);
it.each(actions)(
  "does not replay %s after losing the acknowledgement and receipt read",
  async (action) => {
    const f = await fixture();
    const fault = database({
      action,
      failReceiptRead: true,
      after: async () => {
        throw new Error("lost_ack");
      },
    });
    await expect(f.run(action, f.app(undefined, fault.db))).rejects.toThrow();
    expect(fault.calls()).toBe(1);
    expect(await f.rows(action)).toEqual([
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
    if (action === "issue") {
      const targets = (
        await env.DB.prepare("SELECT manifest_ref FROM target_sets WHERE owner_id=?")
          .bind(f.f.ids.user)
          .all<{ manifest_ref: string }>()
      ).results;
      expect(targets).toHaveLength(2);
      for (const target of targets)
        expect(await env.BLOBS.head(target.manifest_ref)).not.toBeNull();
    }
  },
);
it.each(["accept", "cancel"] as const)(
  "checks actual expiry after %s waits, even though the preflight credential was live",
  async (action) => {
    const f = await fixture(),
      before = await f.snapshot();
    const expiry = Math.ceil(Date.now() / 1000) * 1000 + 2000;
    await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE id=?")
      .bind(expiry, f.credentialRow)
      .run();
    let waited = false;
    await expect(
      f.run(
        action,
        f.app(async (r) => {
          const a = await acquireMutation(r);
          if (matches(r, action)) {
            expect(Date.now()).toBeLessThan(expiry);
            waited = true;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, expiry - Date.now() + 30)),
            );
          }
          return a;
        }),
      ),
    ).rejects.toThrow();
    expect(waited).toBe(true);
    expect(await f.snapshot()).toEqual(before);
  },
);
it.each(
  (["app", "internal", "anonymous"] as const).flatMap((identity) =>
    actions.map((action) => ({ identity, action })),
  ),
)("rechecks the $identity credential after $action admission", async ({ identity, action }) => {
  const f = await fixture(identity),
    before = await f.snapshot();
  await expect(
    f.run(
      action,
      f.app(async (r) => {
        const a = await acquireMutation(r);
        if (matches(r, action)) await f.revoke();
        return a;
      }),
    ),
  ).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect((await f.rows(action))[0]!.committed_at).toBeNull();
});
it("fences a delayed publication before deleting its staged manifest", async () => {
  const f = await fixture(),
    before = await f.snapshot(),
    initial = new Set(objectKeys);
  let delayed: D1PreparedStatement[] | undefined;
  const fault = database({
    action: "issue",
    before: async (statements) => {
      delayed = statements;
      throw new Error("dispatch_unknown");
    },
  });
  await expect(f.run("issue", f.app(undefined, fault.db))).rejects.toThrow();
  expect(delayed).toBeDefined();
  for (const key of objectKeys) if (!initial.has(key)) expect(await env.BLOBS.head(key)).toBeNull();
  await expect(env.DB.batch(delayed!)).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect(await f.rows("issue")).toEqual([
    { state: "closed", committed_at: null, space_id: f.f.ids.space },
  ]);
});
it.each([false, true])(
  "keeps the manifest if the cancellation fence is unknown (committed=%s)",
  async (committed) => {
    const f = await fixture(),
      initial = new Set(objectKeys);
    let publishing = false;
    const fault = database({
      action: "issue",
      before: async () => {
        publishing = true;
        throw new Error("dispatch_unknown");
      },
    });
    const db = {
      prepare: fault.db.prepare.bind(fault.db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!publishing) return fault.db.batch(statements);
        if (committed) await env.DB.batch(statements);
        throw new Error("fence_ack_lost");
      },
    } as unknown as D1Database;
    await expect(f.run("issue", f.app(undefined, db))).rejects.toThrow(
      "content_ticket_commit_unknown",
    );
    const staged = [...objectKeys].filter((key) => !initial.has(key));
    expect(staged).toHaveLength(1);
    expect(await env.BLOBS.head(staged[0]!)).not.toBeNull();
    expect(await f.rows("issue")).toEqual([
      { state: committed ? "closed" : "active", committed_at: null, space_id: f.f.ids.space },
    ]);
  },
);
it("another cancellation cannot prove this invocation committed or release its uncertain slot", async () => {
  const f = await fixture();
  const fault = database({
    action: "cancel",
    before: async () => {
      await cancelContentTicket(mutationEnv(), f.principal, f.issued.ticketId);
      throw new Error("own_dispatch_failed");
    },
  });
  await expect(f.run("cancel", f.app(undefined, fault.db))).rejects.toThrow(
    "ticket_cancel_commit_unknown",
  );
  expect(await f.rows("cancel")).toEqual([
    { state: "active", committed_at: null, space_id: f.f.ids.space },
    { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
  ]);
});
it("rejects an anonymous ticket whose budget now belongs to another unlock session before admission", async () => {
  const f = await fixture("anonymous"),
    other = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
  )
    .bind(other, f.share!.id, "digest-" + other, Date.now(), Date.now() + 500000)
    .run();
  await env.DB.prepare("UPDATE budgets SET unlock_session_id=? WHERE id=?")
    .bind(other, f.issued.budgetId)
    .run();
  let calls = 0;
  await expect(
    f.run(
      "accept",
      f.app(async (r) => {
        calls++;
        return acquireMutation(r);
      }),
    ),
  ).rejects.toThrow("content_ticket_rejected");
  expect(calls).toBe(0);
});
it.each(["issue", "accept", "cancel"] as const)(
  "returns HTTP 503 and Retry-After for overloaded %s, with content CORS intact",
  async (action) => {
    const f = await fixture(),
      app = f.app(async (r) => {
        if (matches(r, action)) throw new Error("full");
        return acquireMutation(r);
      });
    const request = new Request(
      action === "accept"
        ? "https://content.invalid/session"
        : "https://app.invalid/api/v1/" +
            (action === "cancel" ? "tickets/" + f.issued.ticketId : "content-session"),
      {
        method: action === "cancel" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json", Origin: app.APP_ORIGIN },
        ...(action === "cancel"
          ? {}
          : {
              body: JSON.stringify(
                action === "accept"
                  ? { ticket: f.issued.ticket }
                  : { targets: [f.target], purpose: "content", ttlSeconds: 60 },
              ),
            }),
      },
    );
    const response =
      action === "accept"
        ? await handleContentHttp(request, app, f.tokens)
        : await handlePrivateContentTicketHttp(
            request,
            app,
            f.principal,
            { verify: async () => {} },
            f.tokens,
          );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    if (action === "accept") {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(app.APP_ORIGIN);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    }
  },
);
