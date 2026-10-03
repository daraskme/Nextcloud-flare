import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { portableName } from "@next-cloud-flare/shared/names";
import { strToU8, unzipSync, zipSync } from "fflate";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import type { PublicShareDependencies } from "../../src/api/publicShareConfig";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { publicAssets } from "../../src/assets/publicManifest";
import { servePublicShare } from "../../src/assets/publicShare";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { KdfUnavailableError } from "../../src/auth/kdf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import {
  hashSharePassword,
  type SharePasswordPepperRing,
  sharePasswordPepperRing,
} from "../../src/auth/sharePassword";
import { shareSecretDigest } from "../../src/auth/shareSession";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { AUDIO_GENERATOR_VERSION } from "../../src/media/audio";
import { EPUB_INDEX_GENERATOR, inspectEpubObject } from "../../src/media/epub/index";
import { IMAGE_METADATA_GENERATOR } from "../../src/media/images/metadata";
import { VIDEO_METADATA_GENERATOR } from "../../src/media/video";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted } from "../fixtures/uploadEnv";

const origin = "https://app.invalid";
const contentOrigin = "https://content.invalid";
let dependencies: PublicShareDependencies;
let contentTokens: ContentTokens;
let passwordRing: SharePasswordPepperRing;
let passwordPepperKey: string;
let uploadCapabilities: UploadCapabilities;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const privateSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const publicSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cursorSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ticketSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cookieSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  contentTokens = new ContentTokens(
    await contentKeyRing("ticket", { ticket: ticketSecret }),
    await contentKeyRing("cookie", { cookie: cookieSecret }),
    contentOrigin,
  );
  passwordPepperKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  passwordRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    localKdf,
  );
  uploadCapabilities = new UploadCapabilities(
    await contentKeyRing("upload", {
      upload: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  dependencies = {
    csrf: new CsrfTokens(
      await csrfKeyRing("private", { private: privateSecret }),
      await csrfKeyRing("public", { public: publicSecret }),
      origin,
    ),
    cursors: new NodeCursorTokens(await contentKeyRing("cursor", { cursor: cursorSecret })),
    tokens: contentTokens,
    passwordPepper: passwordRing,
    uploadCapabilities,
  };
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(password?: string, ring = passwordRing) {
  const now = Date.now() - 1000;
  const owner = foundationFixture(crypto.randomUUID(), now);
  const outside = foundationFixture(crypto.randomUUID(), now);
  const shareId = crypto.randomUUID();
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const passwordRecord =
    password === undefined ? undefined : await hashSharePassword(password, ring);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...outside.statements,
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,secret_digest,password_digest,salt,kdf,kdf_params,kid,
        expires_at,created_at
      ) VALUES(?,?,?,'link',?,?,?,?,?,?,?,?)`,
      values: [
        shareId,
        owner.ids.user,
        owner.ids.folder,
        await shareSecretDigest(secret),
        passwordRecord?.passwordDigest ?? null,
        passwordRecord?.salt ?? null,
        passwordRecord?.kdf ?? null,
        passwordRecord?.kdfParams ?? null,
        passwordRecord?.kid ?? null,
        now + 600_000,
        now,
      ],
    },
    {
      sql: "INSERT INTO share_actions VALUES(?,'read'),(?,'download')",
      values: [shareId, shareId],
    },
  ]);
  return { owner, outside, shareId, secret };
}

function shareEnv() {
  return {
    ...mutationEnv(),
    APP_ORIGIN: origin,
    CONTENT_ORIGIN: contentOrigin,
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_IP_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
}

function uploadShareEnv() {
  return {
    ...admitted(),
    APP_ORIGIN: origin,
    CONTENT_ORIGIN: contentOrigin,
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_IP_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
}

async function uploadFixture(password?: string, reservationLimit = 10_000_000_000) {
  const result = await fixture(password);
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE shares SET kind='upload_only',reservation_limit=? WHERE id=?",
      values: [reservationLimit, result.shareId],
    },
    { sql: "DELETE FROM share_actions WHERE share_id=?", values: [result.shareId] },
    {
      sql: "INSERT INTO share_actions VALUES(?,'create'),(?,'upload')",
      values: [result.shareId, result.shareId],
    },
    {
      sql: "UPDATE users SET quota_bytes=1000000000000 WHERE id=?",
      values: [result.owner.ids.user],
    },
  ]);
  return result;
}

function unlockRequest(shareId: string, secret: string, password?: string) {
  return new Request(`${origin}/api/v1/public/shares/${shareId}/unlock`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({ secret, ...(password === undefined ? {} : { password }) }),
  });
}

function sessionRequest(path: string, cookie: string, init: RequestInit = {}) {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { Cookie: cookie, ...init.headers },
  });
}

async function uploadSession(f: Awaited<ReturnType<typeof uploadFixture>>) {
  const app = uploadShareEnv();
  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    app,
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  const cookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const csrfResponse = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, cookie, {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    }),
    app,
    1,
    dependencies,
  );
  const token = ((await csrfResponse.json()) as { token: string }).token;
  const send = (
    path: string,
    method: string,
    body?: BodyInit,
    extra: Record<string, string> = {},
  ) =>
    handlePublicShareHttp(
      sessionRequest(path, cookie, {
        method,
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          "Idempotency-Key": crypto.randomUUID(),
          ...extra,
        },
        ...(body === undefined ? {} : { body }),
      }),
      app,
      1,
      dependencies,
    );
  return { app, cookie, token, send };
}

function epubBook(chapter = "<html><body>Public chapter</body></html>"): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<container version="1.0"><rootfiles>
        <rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/>
      </rootfiles></container>`,
    ),
    "OPS/book.opf": strToU8(
      `<package version="3.0"><metadata><dc:title>Public Book</dc:title>
        <dc:creator>Public Author</dc:creator></metadata><manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="chapter"/></spine></package>`,
    ),
    "OPS/chapter.xhtml": strToU8(chapter),
  });
}

async function projectEpub(target: ReturnType<typeof foundationFixture>, chapter?: string) {
  const bytes = epubBook(chapter);
  const blobId = crypto.randomUUID();
  const key = `u/${target.ids.user}/b/${blobId}`;
  const source = await env.BLOBS.put(key, bytes);
  if (!source) throw new Error("fixture_epub_missing");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
        VALUES(?,?,?,?,?,'committed',?)`,
      values: [blobId, target.ids.user, key, bytes.byteLength, `"b-${blobId}"`, Date.now()],
    },
    {
      sql: `UPDATE nodes SET current_blob_id=?,name='Public Book.epub',
        name_ci='public book.epub' WHERE id=?`,
      values: [blobId, target.ids.file],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [blobId, bytes.byteLength, source.etag, Date.now()],
    },
  ]);
  const inspection = await inspectEpubObject(
    env.BLOBS,
    { key, size: bytes.byteLength, r2Etag: source.etag },
    Date.now() + 5_000,
  );
  if (inspection.kind !== "indexed") throw new Error("fixture_epub_not_indexed");
  const indexKey = `u/${target.ids.user}/d/${blobId}/${EPUB_INDEX_GENERATOR}/index/${target.ids.file}-${inspection.sha256}.json`;
  const index = await env.BLOBS.put(indexKey, inspection.bytes);
  if (!index) throw new Error("fixture_epub_index_missing");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO library_items(
        node_id,blob_id,kind,generator_version,title_extracted,author_extracted,page_count
      ) VALUES(?,?,'epub',?,?,?,?)`,
      values: [
        target.ids.file,
        blobId,
        EPUB_INDEX_GENERATOR,
        inspection.index.metadata.title,
        inspection.index.metadata.author,
        inspection.index.spine.length,
      ],
    },
    {
      sql: `INSERT INTO archive_index(
        id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes
      ) VALUES(?,?,?,?,?,?,?,?)`,
      values: [
        crypto.randomUUID(),
        target.ids.file,
        blobId,
        EPUB_INDEX_GENERATOR,
        indexKey,
        inspection.sha256,
        inspection.index.entries.length,
        inspection.bytes.byteLength,
      ],
    },
  ]);
  return {
    key,
    indexKey,
    blobId,
    entryToken: inspection.index.spine[0] ?? "",
    chapter: chapter ?? "<html><body>Public chapter</body></html>",
  };
}

async function readOnlySession(f: Awaited<ReturnType<typeof fixture>>) {
  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  const cookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const csrfResponse = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, cookie, {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    }),
    shareEnv(),
    1,
    dependencies,
  );
  expect(csrfResponse.status).toBe(200);
  const token = ((await csrfResponse.json()) as { token: string }).token;
  return { cookie, token };
}

it("unlocks a capability into a share-bound cookie and reads only the selected tree", async () => {
  const f = await fixture();
  const wrong = await handlePublicShareHttp(
    unlockRequest(f.shareId, base64url.encode(crypto.getRandomValues(new Uint8Array(32)))),
    shareEnv(),
    1,
    dependencies,
  );
  expect(wrong.status).toBe(404);

  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  const setCookie = unlocked.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toContain("Secure; HttpOnly; SameSite=Lax");
  const cookie = setCookie.split(";")[0] ?? "";

  const metadata = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    id: f.shareId,
    contentOrigin,
    root: { id: f.owner.ids.folder, kind: "folder" },
    actions: ["read", "download"],
  });

  const children = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/children/${f.owner.ids.folder}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(children.status).toBe(200);
  expect(await children.json()).toMatchObject({
    parentId: f.owner.ids.folder,
    children: [{ id: f.owner.ids.file, name: "File" }],
  });

  for (const nodeId of [f.owner.ids.root, f.outside.ids.folder]) {
    const response = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/children/${nodeId}`, cookie),
      shareEnv(),
      1,
      dependencies,
    );
    expect(response.status).toBe(404);
  }
  const otherShare = await fixture();
  const wrongShare = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${otherShare.shareId}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(wrongShare.status).toBe(401);
});

it("lists current public gallery and audio projections only while read access remains active", async () => {
  const f = await fixture();
  const now = Date.now();
  const audioBlob = crypto.randomUUID();
  const audioNode = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE blobs SET mime_sniffed='image/jpeg' WHERE id=?",
      values: [f.owner.ids.blob],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'image-etag',?)",
      values: [f.owner.ids.blob, now],
    },
    {
      sql: "INSERT INTO node_media(node_id,blob_id,generator_version,width,height) VALUES(?,?,?,?,?)",
      values: [f.owner.ids.file, f.owner.ids.blob, IMAGE_METADATA_GENERATOR, 1600, 900],
    },
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,mime_sniffed,created_at)
        VALUES(?,?,?,12,'audio-etag','committed','audio/mpeg',?)`,
      values: [audioBlob, f.owner.ids.user, `u/${f.owner.ids.user}/b/${audioBlob}`, now],
    },
    {
      sql: `INSERT INTO nodes
        (id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        VALUES(?,?,?,?,'Track.mp3','track.mp3','file',?,?,?)`,
      values: [
        audioNode,
        f.owner.ids.space,
        f.owner.ids.user,
        f.owner.ids.folder,
        audioBlob,
        now,
        now,
      ],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,12,'audio-etag',?)",
      values: [audioBlob, now],
    },
    {
      sql: `INSERT INTO node_audio
        (node_id,blob_id,generator_version,duration_ms,codec,title_extracted)
        VALUES(?,?,?,185000,'mp3','Track title')`,
      values: [audioNode, audioBlob, AUDIO_GENERATOR_VERSION],
    },
  ]);
  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  const cookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const gallery = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/gallery?recursive=1`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(gallery.status).toBe(200);
  expect(await gallery.json()).toMatchObject({
    rootId: f.owner.ids.folder,
    recursive: true,
    items: [{ id: f.owner.ids.file, mime: "image/jpeg", width: 1600, height: 900 }],
  });
  const tracks = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/tracks?recursive=1`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(tracks.status).toBe(200);
  expect(await tracks.json()).toMatchObject({
    rootId: f.owner.ids.folder,
    recursive: true,
    items: [{ id: audioNode, mime: "audio/mpeg", title: "Track title" }],
  });
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/gallery?extra=1`, cookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(400);
  await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='read'")
    .bind(f.shareId)
    .run();
  for (const media of ["gallery", "tracks"]) {
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(`/api/v1/public/shares/${f.shareId}/${media}?recursive=1`, cookie),
          shareEnv(),
          1,
          dependencies,
        )
      ).status,
    ).toBe(401);
  }
});

it("requires the current password and applies share and IP limits only before password KDF", async () => {
  const password = "correct horse battery staple";
  const f = await fixture(password);
  const shareLimit = vi.fn(async () => ({ success: true }));
  const ipLimit = vi.fn(async () => ({ success: true }));
  const app = {
    ...shareEnv(),
    SHARE_PASSWORD_LIMITER: { limit: shareLimit } as RateLimit,
    SHARE_PASSWORD_IP_LIMITER: { limit: ipLimit } as RateLimit,
  };
  const missing = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    app,
    1,
    dependencies,
  );
  expect(missing.status).toBe(401);
  expect((await missing.json()) as { title: string }).toMatchObject({
    title: "password_required",
  });
  expect(shareLimit).not.toHaveBeenCalled();
  expect(ipLimit).not.toHaveBeenCalled();

  const wrong = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, "wrong"),
    app,
    1,
    dependencies,
  );
  expect(wrong.status).toBe(401);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(f.shareId)
      .first<number>("count"),
  ).toBe(0);
  expect(shareLimit).toHaveBeenLastCalledWith({ key: f.shareId });
  expect(ipLimit).toHaveBeenLastCalledWith({ key: "192.0.2.1" });

  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(f.shareId, f.secret, "x".repeat(1025)),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(f.shareId, f.secret, "\0".repeat(1024)),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  const malformed = new Request(`${origin}/api/v1/public/shares/${f.shareId}/unlock`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({ secret: f.secret, password: 1 }),
  });
  expect((await handlePublicShareHttp(malformed, app, 1, dependencies)).status).toBe(400);

  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    app,
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  expect(unlocked.headers.get("Set-Cookie")).toContain("HttpOnly");

  const unprotected = await fixture();
  shareLimit.mockClear();
  ipLimit.mockClear();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(unprotected.shareId, unprotected.secret),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(200);
  expect(shareLimit).not.toHaveBeenCalled();
  expect(ipLimit).not.toHaveBeenCalled();
});

it("rehashes a verified password under the active pepper before retiring the old key", async () => {
  const password = "rotate this protected share";
  const oldKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const newKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const creationRing = await sharePasswordPepperRing(
    "old",
    { old: oldKey, current: newKey },
    localKdf,
  );
  const verificationRing = await sharePasswordPepperRing(
    "current",
    { old: oldKey, current: newKey },
    localKdf,
  );
  const f = await fixture(password, creationRing);
  const original = await env.DB.prepare(
    "SELECT password_digest AS digest,kid FROM shares WHERE id=?",
  )
    .bind(f.shareId)
    .first<{ digest: string; kid: string }>();
  expect(original?.kid).toBe("old");

  expect(
    (
      await handlePublicShareHttp(unlockRequest(f.shareId, f.secret, password), shareEnv(), 1, {
        ...dependencies,
        passwordPepper: verificationRing,
      })
    ).status,
  ).toBe(200);
  const migrated = await env.DB.prepare(
    "SELECT password_digest AS digest,kid FROM shares WHERE id=?",
  )
    .bind(f.shareId)
    .first<{ digest: string; kid: string }>();
  expect(migrated?.kid).toBe("current");
  expect(migrated?.digest).not.toBe(original?.digest);

  const currentOnly = await sharePasswordPepperRing("current", { current: newKey }, localKdf);
  expect(
    (
      await handlePublicShareHttp(unlockRequest(f.shareId, f.secret, password), shareEnv(), 1, {
        ...dependencies,
        passwordPepper: currentOnly,
      })
    ).status,
  ).toBe(200);
});

it("returns retryable password rate and KDF failures without creating a session", async () => {
  const password = "rate limited";
  const f = await fixture(password);
  const limited = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    {
      ...shareEnv(),
      SHARE_PASSWORD_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    },
    1,
    dependencies,
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  const ipLimited = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    {
      ...shareEnv(),
      SHARE_PASSWORD_IP_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    },
    1,
    dependencies,
  );
  expect(ipLimited.status).toBe(429);
  expect(ipLimited.headers.get("Retry-After")).toBe("60");

  const unavailableRing = await sharePasswordPepperRing(
    "password",
    { password: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    async () => {
      throw new KdfUnavailableError();
    },
  );
  const unavailable = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    shareEnv(),
    1,
    { ...dependencies, passwordPepper: unavailableRing },
  );
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("Retry-After")).toBe("1");
  const missingKeyRing = await sharePasswordPepperRing(
    "other",
    { other: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    localKdf,
  );
  const missingKey = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    shareEnv(),
    1,
    { ...dependencies, passwordPepper: missingKeyRing },
  );
  expect(missingKey.status).toBe(503);
  expect(missingKey.headers.get("Retry-After")).toBe("1");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(f.shareId)
      .first<number>("count"),
  ).toBe(0);
});

it("rejects disabled, expired, stale-epoch, version-changed, and password-changed unlocks", async () => {
  const password = "current password";
  const disabled = await fixture(password);
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), disabled.shareId)
    .run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(disabled.shareId, disabled.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);

  const expired = await fixture(password);
  await env.DB.prepare("UPDATE shares SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, expired.shareId)
    .run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(expired.shareId, expired.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);

  const staleEpoch = await fixture(password);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(staleEpoch.shareId, staleEpoch.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);
  await env.DB.prepare("UPDATE control SET epoch=1").run();

  const changed = await fixture(password);
  const racingRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    async (input, salt) => {
      const result = await localKdf(input, salt);
      await env.DB.prepare("UPDATE shares SET password_digest=? WHERE id=?")
        .bind(base64url.encode(crypto.getRandomValues(new Uint8Array(32))), changed.shareId)
        .run();
      return result;
    },
  );
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(changed.shareId, changed.secret, password),
        shareEnv(),
        1,
        { ...dependencies, passwordPepper: racingRing },
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(changed.shareId)
      .first<number>("count"),
  ).toBe(0);

  const changedVersion = await fixture(password);
  const versionRacingRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    async (input, salt) => {
      const result = await localKdf(input, salt);
      await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
        .bind(changedVersion.shareId)
        .run();
      return result;
    },
  );
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(changedVersion.shareId, changedVersion.secret, password),
        shareEnv(),
        1,
        { ...dependencies, passwordPepper: versionRacingRing },
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(changedVersion.shareId)
      .first<number>("count"),
  ).toBe(0);
});

it("issues, redeems, reuses, and cancels budgeted public content and ZIP tickets", async () => {
  const password = "download password";
  const f = await fixture(password);
  const key = `u/${f.owner.ids.user}/b/${f.owner.ids.blob}`;
  const stored = await env.BLOBS.put(key, "abc");
  if (!stored) throw new Error("fixture_blob_missing");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.owner.ids.blob, stored.etag, Date.now())
    .run();
  const derivativeId = crypto.randomUUID();
  const derivativeKey = `u/${f.owner.ids.user}/d/${f.owner.ids.blob}/image-sm256-v1/sm256/${crypto.randomUUID()}.webp`;
  const derivative = await env.BLOBS.put(derivativeKey, "thumb");
  if (!derivative) throw new Error("fixture_derivative_missing");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO node_media(node_id,blob_id,generator_version,width,height)
        VALUES(?,?,'image-metadata-v1',1,1)`,
      values: [f.owner.ids.file, f.owner.ids.blob],
    },
    {
      sql: `INSERT INTO derivative_results
        (id,blob_id,kind,variant,generator_version,state,epoch,attempts,r2_key,size,r2_etag)
        VALUES(?,?,'thumbnail','sm256','image-sm256-v1','ready',1,1,?,?,?)`,
      values: [derivativeId, f.owner.ids.blob, derivativeKey, derivative.size, derivative.etag],
    },
  ]);
  try {
    const unlocked = await handlePublicShareHttp(
      unlockRequest(f.shareId, f.secret, password),
      shareEnv(),
      1,
      dependencies,
    );
    const shareCookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfResponse = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, shareCookie, {
        method: "POST",
        headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      }),
      shareEnv(),
      1,
      dependencies,
    );
    const { token } = (await csrfResponse.json()) as { token: string };
    const issue = (path: string, nodeId = f.owner.ids.file, purpose = "content") =>
      handlePublicShareHttp(
        sessionRequest(path, shareCookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
          },
          body: JSON.stringify({
            targets: [{ spaceId: f.owner.ids.space, nodeId }],
            purpose,
            ttlSeconds: 300,
          }),
        }),
        shareEnv(),
        1,
        dependencies,
      );
    const issueZip = (nodeId: string, key: string) =>
      handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/nodes/${nodeId}/zip`, shareCookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "X-CSRF-Token": token,
          },
          body: "{}",
        }),
        shareEnv(),
        1,
        dependencies,
      );

    const first = await issue(`/api/v1/public/shares/${f.shareId}/tickets`);
    expect(first.status).toBe(201);
    const issued = (await first.json()) as {
      ticket: string;
      ticketId: string;
      budgetId: string;
    };
    const renewed = await issue(`/api/v1/public/shares/${f.shareId}/content-session`);
    expect(renewed.status).toBe(201);
    expect(((await renewed.json()) as { budgetId: string }).budgetId).toBe(issued.budgetId);
    expect(
      (await issue(`/api/v1/public/shares/${f.shareId}/tickets`, f.outside.ids.file)).status,
    ).toBe(404);

    const accepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(accepted.status).toBe(201);
    const contentCookie = (accepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const contentPath = `/c/${f.owner.ids.file}/${f.owner.ids.blob}`;
    const downloaded = await handleContentHttp(
      new Request(`${contentOrigin}${contentPath}`, {
        headers: { Cookie: contentCookie },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(downloaded.status).toBe(200);
    expect(new TextDecoder().decode(await downloaded.arrayBuffer())).toBe("abc");
    const thumbIssuedResponse = await issue(
      `/api/v1/public/shares/${f.shareId}/tickets`,
      f.owner.ids.file,
      "thumb",
    );
    expect(thumbIssuedResponse.status).toBe(201);
    const thumbIssued = (await thumbIssuedResponse.json()) as { ticket: string };
    const thumbAccepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: thumbIssued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(thumbAccepted.status).toBe(201);
    const thumbCookie = (thumbAccepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const thumbnail = await handleContentHttp(
      new Request(`${contentOrigin}${contentPath}/thumb`, {
        headers: { Cookie: thumbCookie },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(thumbnail.status).toBe(200);
    expect(new TextDecoder().decode(await thumbnail.arrayBuffer())).toBe("thumb");
    const zipKey = crypto.randomUUID();
    const [zipIssuedResponse, concurrentZipReplay] = await Promise.all([
      issueZip(f.owner.ids.folder, zipKey),
      issueZip(f.owner.ids.folder, zipKey),
    ]);
    expect(zipIssuedResponse.status).toBe(201);
    const zipIssued = (await zipIssuedResponse.json()) as {
      ticket: string;
      ticketId: string;
      targetSetId: string;
      budgetId: string;
    };
    expect(concurrentZipReplay.status).toBe(201);
    expect(await concurrentZipReplay.json()).toEqual(zipIssued);
    const zipReplay = await issueZip(f.owner.ids.folder, zipKey);
    expect(zipReplay.status).toBe(201);
    expect(await zipReplay.json()).toEqual(zipIssued);
    expect((await issueZip(f.owner.ids.file, zipKey)).status).toBe(409);
    expect((await issueZip(f.outside.ids.folder, crypto.randomUUID())).status).toBe(404);
    const zipAccepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: zipIssued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(zipAccepted.status).toBe(201);
    const zipCookie = (zipAccepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const zipRedirect = await handlePublicShareHttp(
      sessionRequest(
        `/api/v1/public/shares/${f.shareId}/zips/${zipIssued.targetSetId}`,
        shareCookie,
      ),
      shareEnv(),
      1,
      dependencies,
    );
    expect(zipRedirect.status).toBe(307);
    expect(zipRedirect.headers.get("Location")).toBe(`${contentOrigin}/z/${zipIssued.targetSetId}`);
    const zipped = await handleContentHttp(
      new Request(zipRedirect.headers.get("Location") ?? "", {
        headers: { Cookie: zipCookie },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(zipped.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await zipped.arrayBuffer()));
    expect(new TextDecoder().decode(archive["Folder/File"])).toBe("abc");
    expect(
      (await issue(`/api/v1/public/shares/${f.shareId}/tickets`, f.owner.ids.file, "page")).status,
    ).toBe(404);

    const cancelled = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/tickets/${issued.ticketId}`, shareCookie, {
        method: "DELETE",
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
      }),
      shareEnv(),
      1,
      dependencies,
    );
    expect(cancelled.status).toBe(204);
    expect(
      (
        await handleContentHttp(
          new Request(`${contentOrigin}${contentPath}`, {
            headers: { Cookie: contentCookie },
          }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
    const staleZipResponse = await issueZip(f.owner.ids.folder, crypto.randomUUID());
    expect(staleZipResponse.status).toBe(201);
    const staleZip = (await staleZipResponse.json()) as {
      ticket: string;
      targetSetId: string;
    };
    const staleAccepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: staleZip.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(staleAccepted.status).toBe(201);
    const staleCookie = (staleAccepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(f.shareId).run();
    expect(
      (
        await handleContentHttp(
          new Request(`${contentOrigin}/z/${staleZip.targetSetId}`, {
            headers: { Cookie: staleCookie },
          }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
    await env.DB.prepare("UPDATE shares SET version=version-1 WHERE id=?").bind(f.shareId).run();
    await env.DB.prepare("UPDATE control SET epoch=2").run();
    expect(
      (
        await handleContentHttp(
          new Request(`${contentOrigin}/z/${staleZip.targetSetId}`, {
            headers: { Cookie: staleCookie },
          }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete([key, derivativeKey]);
  }
});

it("streams public audio and video track tickets with current projection and budget fences", async () => {
  const f = await fixture();
  const now = Date.now();
  const videoKey = `u/${f.owner.ids.user}/b/${f.owner.ids.blob}`;
  const videoObject = await env.BLOBS.put(videoKey, "abc");
  if (!videoObject) throw new Error("fixture_video_missing");
  const audioBlob = crypto.randomUUID();
  const audioNode = crypto.randomUUID();
  const audioKey = `u/${f.owner.ids.user}/b/${audioBlob}`;
  const audioObject = await env.BLOBS.put(audioKey, "audio");
  if (!audioObject) throw new Error("fixture_audio_missing");
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE blobs SET mime_sniffed='video/mp4' WHERE id=?",
      values: [f.owner.ids.blob],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [f.owner.ids.blob, videoObject.size, videoObject.etag, now],
    },
    {
      sql: "INSERT INTO node_media(node_id,blob_id,generator_version,width,height) VALUES(?,?,?,1920,1080)",
      values: [f.owner.ids.file, f.owner.ids.blob, "stale-video-generator"],
    },
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,mime_sniffed,created_at)
        VALUES(?,?,?,?,?,'committed','audio/mpeg',?)`,
      values: [audioBlob, f.owner.ids.user, audioKey, audioObject.size, `"b-${audioBlob}"`, now],
    },
    {
      sql: `INSERT INTO nodes
        (id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        VALUES(?,?,?,?,'Track.mp3','track.mp3','file',?,?,?)`,
      values: [
        audioNode,
        f.owner.ids.space,
        f.owner.ids.user,
        f.owner.ids.folder,
        audioBlob,
        now,
        now,
      ],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [audioBlob, audioObject.size, audioObject.etag, now],
    },
    {
      sql: `INSERT INTO node_audio
        (node_id,blob_id,generator_version,duration_ms,codec,title_extracted)
        VALUES(?,?,?,3000,'mp3','Track title')`,
      values: [audioNode, audioBlob, AUDIO_GENERATOR_VERSION],
    },
  ]);
  const issuedTargetSets: string[] = [];
  try {
    const unlocked = await handlePublicShareHttp(
      unlockRequest(f.shareId, f.secret),
      shareEnv(),
      1,
      dependencies,
    );
    const shareCookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfResponse = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, shareCookie, {
        method: "POST",
        headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      }),
      shareEnv(),
      1,
      dependencies,
    );
    const { token } = (await csrfResponse.json()) as { token: string };
    const issue = (nodeId: string) =>
      handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/tickets`, shareCookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
          },
          body: JSON.stringify({
            targets: [{ spaceId: f.owner.ids.space, nodeId }],
            purpose: "track",
            ttlSeconds: 300,
          }),
        }),
        shareEnv(),
        1,
        dependencies,
      );
    expect((await issue(f.owner.ids.file)).status).toBe(404);
    await env.DB.prepare(`UPDATE node_media SET
      generator_version=?,duration_ms=9000,container='mp4',video_codec='av1',audio_codec='opus',
      codec_profile=0,codec_level=8,codec_tier='M',bit_depth=10
      WHERE node_id=?`)
      .bind(VIDEO_METADATA_GENERATOR, f.owner.ids.file)
      .run();
    const videoIssuedResponse = await issue(f.owner.ids.file);
    expect(videoIssuedResponse.status).toBe(201);
    const videoIssued = (await videoIssuedResponse.json()) as {
      ticket: string;
      budgetId: string;
      targetSetId: string;
    };
    issuedTargetSets.push(videoIssued.targetSetId);
    const videoAccepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: videoIssued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    const videoCookie = (videoAccepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const videoUrl = `${contentOrigin}/c/${f.owner.ids.file}/${f.owner.ids.blob}/track`;
    const videoRange = await handleContentHttp(
      new Request(videoUrl, { headers: { Cookie: videoCookie, Range: "bytes=1-3" } }),
      shareEnv(),
      contentTokens,
    );
    expect(videoRange.status).toBe(206);
    expect(videoRange.headers.get("Content-Range")).toBe("bytes 1-2/3");
    expect(videoRange.headers.get("Content-Type")).toBe('video/mp4; codecs="av01.0.08M.10,Opus"');
    expect(new TextDecoder().decode(await videoRange.arrayBuffer())).toBe("bc");
    const videoHead = await handleContentHttp(
      new Request(videoUrl, { method: "HEAD", headers: { Cookie: videoCookie } }),
      shareEnv(),
      contentTokens,
    );
    expect(videoHead.status).toBe(200);
    expect(videoHead.headers.get("Content-Length")).toBe("3");
    expect(videoHead.body).toBeNull();

    const audioIssuedResponse = await issue(audioNode);
    expect(audioIssuedResponse.status).toBe(201);
    const audioIssued = (await audioIssuedResponse.json()) as {
      ticket: string;
      budgetId: string;
      targetSetId: string;
    };
    issuedTargetSets.push(audioIssued.targetSetId);
    expect(audioIssued.budgetId).toBe(videoIssued.budgetId);
    const audioAccepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: audioIssued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    const audioCookie = (audioAccepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const audioUrl = `${contentOrigin}/c/${audioNode}/${audioBlob}/track`;
    const audio = await handleContentHttp(
      new Request(audioUrl, { headers: { Cookie: audioCookie } }),
      shareEnv(),
      contentTokens,
    );
    expect(audio.status).toBe(200);
    expect(audio.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe("audio");

    await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='read'")
      .bind(f.shareId)
      .run();
    expect(
      (
        await handleContentHttp(
          new Request(audioUrl, { headers: { Cookie: audioCookie } }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete([
      videoKey,
      audioKey,
      ...issuedTargetSets.map((id) => `target-sets/${id}`),
    ]);
  }
});

it("does not expose media reads or ZIP tickets to upload-only share sessions", async () => {
  const f = await uploadFixture();
  const session = await uploadSession(f);
  for (const media of ["gallery", "tracks"]) {
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(`/api/v1/public/shares/${f.shareId}/${media}`, session.cookie),
          session.app,
          1,
          dependencies,
        )
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await session.send(
        `/api/v1/public/shares/${f.shareId}/nodes/${f.owner.ids.folder}/zip`,
        "POST",
        "{}",
        { "Idempotency-Key": crypto.randomUUID() },
      )
    ).status,
  ).toBe(404);
  expect(
    (await session.send(`/api/v1/public/shares/${f.shareId}/zips/${crypto.randomUUID()}`, "GET"))
      .status,
  ).toBe(404);
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(
          `/api/v1/public/shares/${f.shareId}/library/${f.owner.ids.file}`,
          session.cookie,
        ),
        session.app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);
});

it("delivers public EPUB metadata and bounded page and entry targets through a page budget", async () => {
  const f = await fixture();
  const publication = await projectEpub(f.owner);
  const outside = await projectEpub(f.outside, "<html><body>Outside</body></html>");
  try {
    const session = await readOnlySession(f);
    const base = `/api/v1/public/shares/${f.shareId}/library/${f.owner.ids.file}`;
    const metadata = await handlePublicShareHttp(
      sessionRequest(base, session.cookie),
      shareEnv(),
      1,
      dependencies,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      nodeId: f.owner.ids.file,
      blobId: publication.blobId,
      title: "Public Book",
      author: "Public Author",
      pageCount: 1,
      spine: [publication.entryToken],
      ticketPurpose: "page",
      pageBaseUrl: `${origin}${base}/pages/`,
      contentBaseUrl: `${origin}${base}/entries/`,
    });
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(
            `/api/v1/public/shares/${f.shareId}/library/${f.outside.ids.file}`,
            session.cookie,
          ),
          shareEnv(),
          1,
          dependencies,
        )
      ).status,
    ).toBe(404);

    const pageTarget = await handlePublicShareHttp(
      sessionRequest(`${base}/pages/1`, session.cookie),
      shareEnv(),
      1,
      dependencies,
    );
    expect(pageTarget.status).toBe(307);
    expect(pageTarget.headers.get("Location")).toBe(
      `${contentOrigin}/c/${f.owner.ids.file}/${publication.blobId}/pages/1`,
    );
    const pageHeadTarget = await handlePublicShareHttp(
      sessionRequest(`${base}/pages/1`, session.cookie, { method: "HEAD" }),
      shareEnv(),
      1,
      dependencies,
    );
    expect(pageHeadTarget.status).toBe(307);
    expect((await pageHeadTarget.arrayBuffer()).byteLength).toBe(0);
    const entryTarget = await handlePublicShareHttp(
      sessionRequest(`${base}/entries/${publication.entryToken}`, session.cookie),
      shareEnv(),
      1,
      dependencies,
    );
    expect(entryTarget.status).toBe(307);
    expect(entryTarget.headers.get("Location")).toBe(
      `${contentOrigin}/c/${f.owner.ids.file}/${publication.blobId}/entries/${publication.entryToken}`,
    );
    const entryHeadTarget = await handlePublicShareHttp(
      sessionRequest(`${base}/entries/${publication.entryToken}`, session.cookie, {
        method: "HEAD",
      }),
      shareEnv(),
      1,
      dependencies,
    );
    expect(entryHeadTarget.status).toBe(307);
    expect((await entryHeadTarget.arrayBuffer()).byteLength).toBe(0);
    for (const path of [`${base}/pages/2`, `${base}/entries/missing`]) {
      expect(
        (
          await handlePublicShareHttp(
            sessionRequest(path, session.cookie),
            shareEnv(),
            1,
            dependencies,
          )
        ).status,
      ).toBe(404);
    }

    const issue = (nodeId: string) =>
      handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/tickets`, session.cookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-CSRF-Token": session.token,
          },
          body: JSON.stringify({
            targets: [{ spaceId: f.owner.ids.space, nodeId }],
            purpose: "page",
            ttlSeconds: 300,
          }),
        }),
        shareEnv(),
        1,
        dependencies,
      );
    expect((await issue(f.outside.ids.file)).status).toBe(404);
    const issuedResponse = await issue(f.owner.ids.file);
    expect(issuedResponse.status).toBe(201);
    const issued = (await issuedResponse.json()) as {
      ticket: string;
      budgetId: string;
    };
    const accepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(accepted.status).toBe(201);
    const contentCookie = (accepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const pagePath = `/c/${f.owner.ids.file}/${publication.blobId}/pages/1`;
    const page = await handleContentHttp(
      new Request(`${contentOrigin}${pagePath}`, {
        headers: { Cookie: contentCookie, Origin: origin },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(await page.arrayBuffer())).toBe(publication.chapter);
    const head = await handleContentHttp(
      new Request(`${contentOrigin}${pagePath}`, {
        method: "HEAD",
        headers: { Cookie: contentCookie },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(publication.chapter).byteLength),
    );
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const entryHead = await handleContentHttp(
      new Request(
        `${contentOrigin}/c/${f.owner.ids.file}/${publication.blobId}/entries/${publication.entryToken}`,
        { method: "HEAD", headers: { Cookie: contentCookie } },
      ),
      shareEnv(),
      contentTokens,
    );
    expect(entryHead.status).toBe(200);
    expect(entryHead.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(publication.chapter).byteLength),
    );
    expect((await entryHead.arrayBuffer()).byteLength).toBe(0);
    const ranged = await handleContentHttp(
      new Request(
        `${contentOrigin}/c/${f.owner.ids.file}/${publication.blobId}/entries/${publication.entryToken}`,
        { headers: { Cookie: contentCookie, Range: "bytes=0-5" } },
      ),
      shareEnv(),
      contentTokens,
    );
    expect(ranged.status).toBe(206);
    expect(new TextDecoder().decode(await ranged.arrayBuffer())).toBe(
      publication.chapter.slice(0, 6),
    );
    const budget = env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId));
    expect(await budget.status()).toMatchObject({
      bytesCharged: new TextEncoder().encode(publication.chapter).byteLength + 6,
      requests: 4,
      active: 0,
    });

    await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='read'")
      .bind(f.shareId)
      .run();
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(base, session.cookie),
          shareEnv(),
          1,
          dependencies,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleContentHttp(
          new Request(`${contentOrigin}${pagePath}`, { headers: { Cookie: contentCookie } }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete([publication.key, publication.indexKey, outside.key, outside.indexKey]);
  }
});

it("fails closed when a public EPUB projection is malformed", async () => {
  const f = await fixture();
  const publication = await projectEpub(f.owner);
  try {
    const session = await readOnlySession(f);
    await env.BLOBS.put(publication.indexKey, "{}");
    const base = `/api/v1/public/shares/${f.shareId}/library/${f.owner.ids.file}`;
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(base, session.cookie),
          shareEnv(),
          1,
          dependencies,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePublicShareHttp(
          sessionRequest(`/api/v1/public/shares/${f.shareId}/tickets`, session.cookie, {
            method: "POST",
            headers: {
              Origin: origin,
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/json",
              "X-CSRF-Token": session.token,
            },
            body: JSON.stringify({
              targets: [{ spaceId: f.owner.ids.space, nodeId: f.owner.ids.file }],
              purpose: "page",
              ttlSeconds: 300,
            }),
          }),
          shareEnv(),
          1,
          dependencies,
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete([publication.key, publication.indexKey]);
  }
});

it("requires current share/session state and revokes through public CSRF logout", async () => {
  const f = await fixture();
  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  const cookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const csrf = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, cookie, {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    }),
    shareEnv(),
    1,
    dependencies,
  );
  expect(csrf.status).toBe(200);
  const { token } = (await csrf.json()) as { token: string };
  const logout = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/logout`, cookie, {
      method: "POST",
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      body: "{}",
    }),
    shareEnv(),
    1,
    dependencies,
  );
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, cookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);

  const second = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  const currentCookie = (second.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(f.shareId).run();
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, currentCookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, currentCookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
});

it("serves an isolated no-store shell and immutable hashed public assets", async () => {
  const shell = await servePublicShare(
    new Request(`${origin}/s/${crypto.randomUUID()}`),
    shareEnv(),
  );
  expect(shell.status).toBe(200);
  expect(shell.headers.get("Cache-Control")).toBe("public, no-store");
  expect(shell.headers.get("Content-Security-Policy")).toContain(
    `connect-src 'self' ${contentOrigin}`,
  );
  expect(shell.headers.get("Content-Security-Policy")).toContain(`img-src 'self' ${contentOrigin}`);
  expect(shell.headers.get("Content-Security-Policy")).toContain(`media-src ${contentOrigin}`);
  const html = await shell.text();
  for (const path of publicAssets)
    if (path !== "/public-assets/client-media-worker.js") expect(html).toContain(path);
  expect(html).not.toContain("/private-assets/");
  for (const path of publicAssets) {
    const asset = await servePublicShare(new Request(`${origin}${path}`), shareEnv());
    expect(asset.status).toBe(200);
    if (path === "/public-assets/client-media-worker.js") {
      expect(asset.headers.get("Cache-Control")).toBe("public, no-store");
      expect(asset.headers.get("Service-Worker-Allowed")).toBe("/");
      expect(asset.headers.get("Content-Type")).toMatch(/javascript/);
    } else {
      expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.has("Service-Worker-Allowed")).toBe(false);
    }
  }
  expect(
    (
      await servePublicShare(
        new Request(`${origin}/public-assets/client-media-worker.js?unexpected=1`),
        shareEnv(),
      )
    ).status,
  ).toBe(404);
});

it("accepts and aborts an upload-only single file without exposing its name", async () => {
  const f = await uploadFixture();
  const session = await uploadSession(f);
  const created = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "report.txt", declared_size: 3 }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { receiptId: string; statusUrl: string };
  expect(receipt).toEqual({
    receiptId: expect.any(String),
    statusUrl: `/api/v1/public/shares/${f.shareId}/uploads/${receipt.receiptId}`,
  });
  const capability = created.headers.get("Upload-Capability") ?? "";
  expect(
    (
      await session.send(`${receipt.statusUrl}/content`, "PUT", "abc", {
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
        "Upload-Capability": capability,
        "X-CSRF-Token": "",
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await session.send(receipt.statusUrl, "GET", undefined, {
        "Upload-Capability": capability,
      })
    ).json(),
  ).toEqual({
    receiptId: receipt.receiptId,
    statusUrl: receipt.statusUrl,
    mode: "single",
    state: "completing",
    declaredSize: 3,
    expiresAt: expect.any(Number),
    cleanupPending: false,
    errorCode: null,
  });
  const abortable = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "cancel.txt", declared_size: 1 }),
  );
  const abortReceipt = (await abortable.json()) as { receiptId: string; statusUrl: string };
  expect(
    (
      await session.send(abortReceipt.statusUrl, "DELETE", "{}", {
        "Upload-Capability": abortable.headers.get("Upload-Capability") ?? "",
      })
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.owner.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(f.shareId)
      .first("reserved_bytes"),
  ).toBe(3);
});

it("allows authenticated cancellation of an old public upload after encryption becomes required", async () => {
  const f = await uploadFixture();
  const session = await uploadSession(f);
  const created = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "old.txt", declared_size: 3 }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { receiptId: string; statusUrl: string };
  const capability = created.headers.get("Upload-Capability") ?? "";
  (
    session.app as typeof session.app & { CLIENT_ENCRYPTION_REQUIRED?: string }
  ).CLIENT_ENCRYPTION_REQUIRED = "true";
  expect(
    (await session.send(receipt.statusUrl, "GET", undefined, { "Upload-Capability": capability }))
      .status,
  ).toBe(200);
  expect(
    (
      await session.send(`${receipt.statusUrl}/content`, "PUT", "abc", {
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
        "Upload-Capability": capability,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await session.send(
        `/api/v1/public/shares/${f.shareId}/uploads`,
        "POST",
        JSON.stringify({ mode: "single", name: "new.txt", declared_size: 1 }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await session.send(receipt.statusUrl, "DELETE", "{}", { "Upload-Capability": "invalid" }))
      .status,
  ).toBe(403);
  expect(
    (
      await session.send(receipt.statusUrl, "DELETE", "{}", {
        "Upload-Capability": capability,
        "X-CSRF-Token": "invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (await session.send(receipt.statusUrl, "DELETE", "{}", { "Upload-Capability": capability }))
      .status,
  ).toBe(200);
  expect(
    await env.DB.prepare(`SELECT u.state AS uploadState,r.state AS reservationState
    FROM uploads u JOIN reservations r ON r.id=u.reservation_id WHERE u.id=?`)
      .bind(receipt.receiptId)
      .first(),
  ).toMatchObject({
    uploadState: "aborted",
    reservationState: "released",
  });
});

it("completes an upload-only single file without disclosing its stored name", async () => {
  const f = await uploadFixture();
  const session = await uploadSession(f);
  const created = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "complete.txt", declared_size: 3 }),
    { "Idempotency-Key": "complete-create" },
  );
  const receipt = (await created.json()) as { receiptId: string; statusUrl: string };
  const capability = created.headers.get("Upload-Capability") ?? "";
  expect(
    (
      await session.send(`${receipt.statusUrl}/content`, "PUT", "abc", {
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
        "Upload-Capability": capability,
        "X-CSRF-Token": "",
      })
    ).status,
  ).toBe(200);
  const uploadName = await env.DB.prepare("SELECT upload_name FROM uploads WHERE id=?")
    .bind(receipt.receiptId)
    .first<string>("upload_name");
  expect(uploadName).toEqual(expect.any(String));
  const normalized = portableName(uploadName ?? "");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'folder',?,?)`,
  )
    .bind(
      "collision",
      f.owner.ids.space,
      f.owner.ids.user,
      f.owner.ids.folder,
      normalized.name,
      normalized.nameCi,
      now,
      now,
    )
    .run();
  const completed = await session.send(`${receipt.statusUrl}/complete`, "POST", "{}", {
    "Idempotency-Key": "complete-publish",
    "Upload-Capability": capability,
  });
  expect(completed.status).toBe(201);
  expect(await completed.json()).toEqual({
    receiptId: receipt.receiptId,
    statusUrl: receipt.statusUrl,
    state: "completed",
  });
  const retried = await session.send(`${receipt.statusUrl}/complete`, "POST", "{}", {
    "Idempotency-Key": "complete-publish",
    "Upload-Capability": capability,
  });
  expect(retried.status).toBe(201);
  expect(await retried.json()).toEqual({
    receiptId: receipt.receiptId,
    statusUrl: receipt.statusUrl,
    state: "completed",
  });
  const storedName = await env.DB.prepare(
    "SELECT name FROM nodes WHERE parent_id=? AND kind='file' AND current_blob_id IS NOT NULL",
  )
    .bind(f.owner.ids.folder)
    .first<string>("name");
  expect(storedName).toEqual(expect.any(String));
  expect(storedName).not.toBe(uploadName);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(f.shareId)
      .first("reserved_bytes"),
  ).toBe(0);
});

it("connects upload-only multipart transfer, completion, and abort", async () => {
  const f = await uploadFixture();
  const session = await uploadSession(f);
  const created = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "multipart", name: "parts.bin", declared_size: 3 }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { receiptId: string; statusUrl: string };
  const capability = created.headers.get("Upload-Capability") ?? "";
  expect(
    (
      await session.send(`${receipt.statusUrl}/parts/1`, "PUT", "abc", {
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
        "Upload-Attempt-Id": "public-part",
        "Upload-Capability": capability,
        "X-CSRF-Token": "",
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await session.send(receipt.statusUrl, "GET", undefined, {
        "Upload-Capability": capability,
      })
    ).json(),
  ).toMatchObject({
    receiptId: receipt.receiptId,
    mode: "multipart",
    state: "uploading",
    parts: [{ partNumber: 1, attemptId: "public-part", state: "completed" }],
  });
  const completed = await session.send(`${receipt.statusUrl}/complete`, "POST", "{}", {
    "Idempotency-Key": "multipart-complete",
    "Upload-Capability": capability,
  });
  expect(completed.status).toBe(201);
  expect(await completed.json()).toEqual({
    receiptId: receipt.receiptId,
    statusUrl: receipt.statusUrl,
    state: "completed",
  });

  const abortable = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "multipart", name: "cancel.bin", declared_size: 3 }),
  );
  const abortReceipt = (await abortable.json()) as { receiptId: string; statusUrl: string };
  expect(
    (
      await session.send(abortReceipt.statusUrl, "DELETE", "{}", {
        "Upload-Capability": abortable.headers.get("Upload-Capability") ?? "",
      })
    ).status,
  ).toBe(202);
  expect(
    await env.DB.prepare("SELECT state FROM uploads WHERE id=?")
      .bind(abortReceipt.receiptId)
      .first("state"),
  ).toBe("aborting");
});

it("fences upload-only receipts by CSRF, capacity, session, share state, and read denial", async () => {
  const f = await uploadFixture(undefined, 2);
  const session = await uploadSession(f);
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/uploads`, session.cookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "Idempotency-Key": "missing-csrf",
          },
          body: JSON.stringify({ mode: "single", name: "csrf.bin", declared_size: 1 }),
        }),
        session.app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await session.send(
        `/api/v1/public/shares/${f.shareId}/uploads`,
        "POST",
        JSON.stringify({ mode: "single", name: "too-large.bin", declared_size: 3 }),
      )
    ).status,
  ).toBe(507);
  await env.DB.prepare("UPDATE shares SET reservation_limit=10 WHERE id=?").bind(f.shareId).run();
  const created = await session.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "fenced.bin", declared_size: 3 }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { receiptId: string; statusUrl: string };
  const capability = created.headers.get("Upload-Capability") ?? "";
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}/children`, session.cookie),
        session.app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);
  await env.DB.prepare(
    "UPDATE share_sessions SET revoked_at=? WHERE share_id=? AND revoked_at IS NULL",
  )
    .bind(Date.now(), f.shareId)
    .run();
  expect(
    (
      await session.send(receipt.statusUrl, "GET", undefined, {
        "Upload-Capability": capability,
      })
    ).status,
  ).toBe(401);

  const versionSession = await uploadSession(f);
  const versioned = await versionSession.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "versioned.bin", declared_size: 1 }),
  );
  const versionedReceipt = (await versioned.json()) as { statusUrl: string };
  await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(f.shareId).run();
  expect(
    (
      await versionSession.send(versionedReceipt.statusUrl, "GET", undefined, {
        "Upload-Capability": versioned.headers.get("Upload-Capability") ?? "",
      })
    ).status,
  ).toBe(401);

  const expiredSession = await uploadSession(f);
  const expiring = await expiredSession.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "expired.bin", declared_size: 1 }),
  );
  const expiringReceipt = (await expiring.json()) as { statusUrl: string };
  await env.DB.prepare("UPDATE shares SET expires_at=? WHERE id=?")
    .bind(Date.now() - 2_000, f.shareId)
    .run();
  expect(
    (
      await expiredSession.send(expiringReceipt.statusUrl, "GET", undefined, {
        "Upload-Capability": expiring.headers.get("Upload-Capability") ?? "",
      })
    ).status,
  ).toBe(401);

  await env.DB.prepare("UPDATE shares SET expires_at=?,disabled_at=NULL WHERE id=?")
    .bind(Date.now() + 600_000, f.shareId)
    .run();
  const disabledSession = await uploadSession(f);
  const disabling = await disabledSession.send(
    `/api/v1/public/shares/${f.shareId}/uploads`,
    "POST",
    JSON.stringify({ mode: "single", name: "disabled.bin", declared_size: 1 }),
  );
  const disablingReceipt = (await disabling.json()) as { statusUrl: string };
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), f.shareId)
    .run();
  expect(
    (
      await disabledSession.send(disablingReceipt.statusUrl, "GET", undefined, {
        "Upload-Capability": disabling.headers.get("Upload-Capability") ?? "",
      })
    ).status,
  ).toBe(401);
});
