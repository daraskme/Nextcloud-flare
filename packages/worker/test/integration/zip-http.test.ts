import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handlePrivateAppHttp, privateAppRoute } from "../../src/api/privateApp";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { handleZipHttp, zipRoute } from "../../src/api/zips";
import { accessPrincipal } from "../../src/auth/authorize";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { createInternalShare } from "../../src/services/internalShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";
import { publicShareFixture } from "../fixtures/publicShare";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
interface ZipReceipt {
  id: string;
  size: number;
  expiresAt: number;
  url: string;
}

async function fixture(kind: "private" | "public" | "upload_only" = "public") {
  const t = await publicShareFixture(kind === "upload_only" ? "upload_only" : "read");
  const ring = await contentKeyRing("test", { test: t.key });
  const tokens = new ContentTokens(ring, ring, "https://content.invalid");
  const csrf = new CsrfTokens(ring, ring, t.app.APP_ORIGIN);
  const principal = kind === "private" ? accessPrincipal(t.owner) : publicPrincipal(t.session);
  const prefix = kind === "private" ? "/api/v1" : `/api/v1/public/shares/${t.share.id}`;
  const storedKey = `u/${t.f.ids.user}/b/${t.f.ids.blob}`;
  const stored = (await env.BLOBS.put(storedKey, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(t.f.ids.blob, stored.etag, Date.now())
    .run();
  const request = (path: string, method = "GET", body?: unknown, token?: string) =>
    t.request(path.startsWith("/api/") ? path : `${prefix}${path}`, method, body, token);
  const privateCsrf = await csrf.issue(env.DB, request("/csrf", "POST"), {
    kind: "access",
    credentialId: t.owner.credential_id,
    epoch: 1,
  });
  const deps = { ...t.deps, contentTokens: tokens };
  const http = (r: Request) =>
    kind === "private"
      ? handleZipHttp(r, t.app, principal, csrf, tokens, t.owner.expires_at)
      : handlePublicShareHttp(r, t.app, 1, deps);
  const create = (nodeId = t.f.ids.folder, body: unknown = {}) =>
    request(`/nodes/${nodeId}/zip`, "POST", body, kind === "private" ? privateCsrf.token : t.token);
  const issue = async (nodeId = t.f.ids.folder) => {
    const response = await http(create(nodeId));
    expect(response.status).toBe(201);
    const receipt = await response.json<ZipReceipt>();
    expect(Object.keys(receipt).sort()).toEqual(["expiresAt", "id", "size", "url"]);
    expect(receipt.url).toBe(`${prefix}/zips/${receipt.id}`);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    return receipt;
  };
  const get = async (receipt: ZipReceipt) => {
    const req = request(receipt.url);
    req.headers.delete("Origin");
    req.headers.delete("Share-Session");
    return http(req);
  };
  return {
    ...t,
    principal,
    prefix,
    storedKey,
    tokens,
    csrf,
    deps,
    request,
    http,
    create,
    issue,
    get,
  };
}

it.each(["private", "public"] as const)(
  "streams a %s ZIP with exact bytes, attachment headers and no bearer URL",
  async (kind) => {
    const t = await fixture(kind),
      receipt = await t.issue();
    expect(kind === "private" ? privateAppRoute(t.create()) : publicShareRoute(t.create())).toBe(
      true,
    );
    const response = await t.get(receipt);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"download.zip\"; filename*=UTF-8''Folder.zip",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const data = new Uint8Array(await response.arrayBuffer());
    expect(data.length).toBe(receipt.size);
    expect(Number(response.headers.get("Content-Length"))).toBe(data.length);
    expect(new TextDecoder().decode(unzipSync(data).File)).toBe("abc");
    expect((await auditOwnerLedger(env.DB, t.f.ids.user))?.incorrect_refs).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
        .bind(t.f.ids.blob)
        .first("n"),
    ).toBe(1);
  },
);

it("routes private ZIPs through real Access registration and CSRF verification", async () => {
  const t = await fixture("private"),
    access = await accessFixture();
  await env.DB.prepare("UPDATE control SET bootstrap_done_at=?").bind(Date.now()).run();
  const assertion = await access.sign({
    sub: t.f.ids.user,
    email: "fixture@example.invalid",
    exp: Math.floor(Date.now() / 1000) + 120,
  });
  const jwt = assertion.headers.get("Cf-Access-Jwt-Assertion")!;
  const deps = {
    verifier: access.verifier,
    csrf: t.csrf,
    tokens: t.tokens,
    bootstrap: { ownerEmails: [], ownerIdentities: [], quotaBytes: 10_000_000 },
  };
  const http = (r: Request) => handlePrivateAppHttp(r, t.app, 1, deps);
  expect((await http(t.create())).status).toBe(401);
  const csrfRequest = t.request("/api/v1/csrf", "POST");
  csrfRequest.headers.set("Cf-Access-Jwt-Assertion", jwt);
  const issued = await http(csrfRequest);
  expect(issued.status).toBe(201);
  const { token } = await issued.json<{ token: string }>();
  const create = t.create();
  create.headers.set("Cf-Access-Jwt-Assertion", jwt);
  create.headers.set("X-CSRF-Token", token);
  const created = await http(create);
  expect(created.status).toBe(201);
  const receipt = await created.json<ZipReceipt>(),
    get = t.request(receipt.url);
  get.headers.set("Cf-Access-Jwt-Assertion", jwt);
  const response = await http(get);
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(receipt.size);
});

it("includes Unicode and empty directories and emits a 22-byte empty ZIP", async () => {
  const t = await fixture(),
    folder = crypto.randomUUID(),
    now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    VALUES(?,?,?,?,'空の資料','空の資料','folder',?,?)`,
      values: [folder, t.f.ids.space, t.f.ids.user, t.f.ids.folder, now, now],
    },
  ]);
  const receipt = await t.issue(),
    bytes = new Uint8Array(await (await t.get(receipt)).arrayBuffer());
  expect(Object.keys(unzipSync(bytes))).toEqual(["File", "空の資料/"]);
  const empty = await t.issue(folder);
  expect(empty.size).toBe(22);
  expect((await (await t.get(empty)).arrayBuffer()).byteLength).toBe(22);
});

it("counts rejected ranges and shares the spent allowance across ZIP reissues", async () => {
  const t = await fixture(),
    receipt = await t.issue();
  const ranged = t.request(receipt.url);
  ranged.headers.set("Range", "bytes=0-9");
  const rejected = await t.http(ranged);
  expect(rejected.status).toBe(416);
  expect(await rejected.text()).toBe("");
  expect(rejected.headers.get("Content-Range")).toBe(`bytes */${receipt.size}`);
  for (let i = 0; i < 3; i++)
    expect((await (await t.get(receipt)).arrayBuffer()).byteLength).toBe(receipt.size);
  expect((await t.get(receipt)).status).toBe(429);
  const retry = await t.issue();
  expect(retry.id).not.toBe(receipt.id);
  expect((await t.get(retry)).status).toBe(429);
  const budget = env.BUDGETS.get(
    env.BUDGETS.idFromName(`s:${t.share.id}:c:${t.session.claims.session_id}`),
  );
  expect(await budget.status()).toMatchObject({
    bytesCharged: receipt.size * 3,
    byteLimit: receipt.size * 3,
    requests: 4,
    active: 0,
  });
});

it.each(["csrf", "session", "body", "scope", "file", "query"])(
  "rejects invalid public ZIP creation: %s",
  async (mode) => {
    const t = await fixture();
    let request = t.create(
      mode === "scope" ? t.f.ids.root : mode === "file" ? t.f.ids.file : t.f.ids.folder,
      mode === "body" ? { names: ["../escape"], spaceId: t.f.ids.space } : {},
    );
    if (mode === "csrf") request.headers.delete("X-CSRF-Token");
    if (mode === "session") request.headers.delete("Share-Session");
    if (mode === "query") request = new Request(`${request.url}?ticket=secret`, request);
    expect((await t.http(request)).status).toBe(
      mode === "csrf"
        ? 403
        : mode === "session"
          ? 412
          : ["body", "query"].includes(mode)
            ? 400
            : 404,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM target_sets WHERE owner_id=?")
        .bind(t.f.ids.user)
        .first("n"),
    ).toBe(0);
  },
);

it("keeps upload-only links closed and never accepts a ZIP ID without its original credential", async () => {
  const upload = await fixture("upload_only");
  expect((await upload.http(upload.create())).status).toBe(404);
  const t = await fixture(),
    receipt = await t.issue(),
    request = t.request(receipt.url);
  request.headers.delete("Cookie");
  expect((await t.http(request)).status).toBe(401);
  const other = await fixture();
  const guessed = other.request(`/zips/${receipt.id}`);
  expect((await other.http(guessed)).status).toBe(404);
  expect(
    zipRoute(new Request(`https://app.invalid/api/v1/zips/${receipt.id}`, { method: "HEAD" })),
  ).toBe(false);
});

it.each(["share", "rename", "revision", "pin", "manifest"])(
  "rejects a changed %s before another download",
  async (change) => {
    const t = await fixture(),
      receipt = await t.issue();
    if (change === "share")
      await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(t.share.id).run();
    if (change === "rename")
      await env.DB.prepare("UPDATE nodes SET name='changed',name_ci='changed' WHERE id=?")
        .bind(t.f.ids.file)
        .run();
    if (change === "revision")
      await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
        .bind(t.f.ids.file)
        .run();
    if (change === "pin")
      await env.DB.prepare("DELETE FROM blob_pins WHERE blob_id=?").bind(t.f.ids.blob).run();
    if (change === "manifest") {
      const ref = await env.DB.prepare(
        "SELECT ts.manifest_ref FROM target_sets ts JOIN tickets t ON t.target_set_id=ts.id WHERE t.id=?",
      )
        .bind(receipt.id)
        .first<string>("manifest_ref");
      await env.BLOBS.put(ref!, "{}");
    }
    const response = await t.get(receipt);
    expect([401, 404, 503]).toContain(response.status);
    expect(await response.text()).not.toContain(t.f.ids.blob);
  },
);

it("keeps an authorized in-flight snapshot pinned through cancellation and removal of its node reference", async () => {
  const t = await fixture(),
    receipt = await t.issue(),
    response = await t.get(receipt);
  expect(response.status).toBe(200);
  await cancelContentTicket(t.app, t.principal, receipt.id);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(t.f.ids.file).run();
  expect(
    await env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?")
      .bind(t.f.ids.blob)
      .first("ref_count"),
  ).toBe(1);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(new TextDecoder().decode(files.File)).toBe("abc");
  expect((await t.get(receipt)).status).toBe(404);
  expect((await auditOwnerLedger(env.DB, t.f.ids.user))?.incorrect_refs).toBe(0);
});

it("charges a disconnected response and leaves pins available for other readers until expiry", async () => {
  const t = await fixture(),
    receipt = await t.issue(),
    response = await t.get(receipt);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  const budget = env.BUDGETS.get(
    env.BUDGETS.idFromName(`s:${t.share.id}:c:${t.session.claims.session_id}`),
  );
  expect(await budget.status()).toMatchObject({ bytesCharged: receipt.size, active: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
      .bind(t.f.ids.blob)
      .first("n"),
  ).toBe(1);
  expect((await (await t.get(receipt)).arrayBuffer()).byteLength).toBe(receipt.size);
});

it("binds an internal recipient ZIP to the selected share and its earlier expiry", async () => {
  const t = await fixture("private"),
    recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, recipient.statements);
  await env.DB.prepare("UPDATE users SET email='zip-recipient@example.invalid' WHERE id=?")
    .bind(recipient.ids.user)
    .run();
  const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 60_000;
  const share = await createInternalShare(t.app, t.owner, {
    kind: "internal",
    rootNodeId: t.f.ids.folder,
    recipients: ["zip-recipient@example.invalid"],
    role: "read",
    expiresAt,
  });
  const session = (await readAccessSession(env.DB, recipient.ids.credential, 1))!;
  const principal = accessPrincipal(session);
  const token = (
    await t.csrf.issue(env.DB, t.request("/csrf", "POST"), {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: 1,
    })
  ).token;
  const http = (request: Request) =>
    handleZipHttp(request, t.app, principal, t.csrf, t.tokens, session.expires_at);
  const create = (body: unknown) =>
    http(t.request(`/nodes/${t.f.ids.folder}/zip`, "POST", body, token));
  expect((await create({})).status).toBe(404);
  expect((await create({ share: { ...share, version: share.version + 1 } })).status).toBe(404);
  const issued = await create({ share });
  expect(issued.status).toBe(201);
  const receipt = await issued.json<ZipReceipt>();
  expect(receipt.expiresAt).toBe(expiresAt);
  const response = await http(t.request(receipt.url));
  expect(response.status).toBe(200);
  expect(
    new TextDecoder().decode(unzipSync(new Uint8Array(await response.arrayBuffer())).File),
  ).toBe("abc");
  expect(
    await env.DB.prepare("SELECT MIN(expires_at) AS expiry FROM blob_pins WHERE blob_id=?")
      .bind(t.f.ids.blob)
      .first("expiry"),
  ).toBe(expiresAt);
  await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(share.id).run();
  expect([404, 503]).toContain((await http(t.request(receipt.url))).status);
});

it.each(["missing", "changed"])(
  "fails the ZIP body and charges the lease when R2 data is %s",
  async (mode) => {
    const t = await fixture(),
      receipt = await t.issue();
    if (mode === "missing") await env.BLOBS.delete(t.storedKey);
    else await env.BLOBS.put(t.storedKey, "xyz");
    const response = await t.get(receipt);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    const budget = env.BUDGETS.get(
      env.BUDGETS.idFromName(`s:${t.share.id}:c:${t.session.claims.session_id}`),
    );
    expect(await budget.status()).toMatchObject({ bytesCharged: receipt.size, active: 0 });
    expect((await auditOwnerLedger(env.DB, t.f.ids.user))?.incorrect_refs).toBe(0);
  },
);
