import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import type { Env } from "../../src/env.js";
import { app } from "../../src/index.js";
import { enqueueLibraryJob, processLibraryJob } from "../../src/jobs/library.js";
import { indexZipArchive } from "../../src/media/archive/zip.js";
import {
  addLibraryRoot,
  getLibraryItem,
  listLibraryItems,
  saveReadingState,
  serveEpubEntry,
  serveLibraryCover,
  serveLibraryPage,
} from "../../src/services/library.js";
import { createShare } from "../../src/services/shares.js";
import { completeUpload } from "../../src/services/uploads/complete.js";
import { createUpload } from "../../src/services/uploads/create.js";
import { putSingleContent } from "../../src/services/uploads/transfer.js";
import { seedFoundation } from "../helpers/foundation.js";

const user: AuthenticatedUser = {
  email: "user@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "user",
    userId: "user",
    sessionId: "session",
    credentialId: "as:session",
    scopes: [],
  },
};

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const stream = new Response(bytes).body;
  if (stream === null) throw new Error("body missing");
  return stream;
}

function capability(upload: { capability?: string }): string {
  if (upload.capability === undefined) throw new Error("capability missing");
  return upload.capability;
}

function fakeImages(): ImagesBinding {
  const transformer = {
    transform() {
      return transformer;
    },
    draw() {
      return transformer;
    },
    output() {
      return Promise.resolve({
        response: () => new Response(new Uint8Array([87, 69, 66, 80])),
        contentType: () => "image/webp",
        image: () => {
          const body = new Response(new Uint8Array([87, 69, 66, 80])).body;
          if (body === null) throw new Error("missing body");
          return body;
        },
      });
    },
  };
  return {
    info() {
      return Promise.resolve({
        format: "png" as const,
        fileSize: 4,
        width: 600,
        height: 900,
      });
    },
    input() {
      return transformer;
    },
  } as unknown as ImagesBinding;
}

function withImages(): Env {
  return { ...env, IMAGES: fakeImages() };
}

async function seedBook(id: string, name: string, mime: string, bytes: Uint8Array): Promise<void> {
  const now = Date.now();
  await env.BLOBS.put(`u/user/b/${id}-blob`, bytes);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES(?1,'user',?2,?3,?4,?5,1,'committed',?6)",
    ).bind(`${id}-blob`, `u/user/b/${id}-blob`, bytes.byteLength, `"b-${id}-blob"`, mime, now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES(?1,'space','user','root',?2,?3,'file',?4,1,?5,?5,0)",
    ).bind(id, name, name.toLowerCase(), `${id}-blob`, now),
  ]);
}

async function enqueue(id: string): Promise<string> {
  const messages: string[] = [];
  const jobId = await enqueueLibraryJob(env, id, (message) => {
    messages.push(message.jobId);
    return Promise.resolve();
  });
  if (jobId === null) throw new Error("library job missing");
  expect(messages).toEqual([jobId]);
  return jobId;
}

beforeEach(async () => {
  await seedFoundation();
  await addLibraryRoot(env, "user", "root");
});

describe("Phase 8B Bookshelf", () => {
  it("creates a fenced durable library job in the upload mutation", async () => {
    const archive = zipSync({ "1.jpg": new Uint8Array([1, 2, 3]) }, { level: 0 });
    const upload = await createUpload(env, user, {
      parentId: "root",
      name: "queued.cbz",
      declaredSize: archive.byteLength,
      mode: "single",
    });
    await putSingleContent(
      env,
      user,
      upload.id,
      capability(upload),
      body(archive),
      archive.byteLength,
    );
    const node = await completeUpload(env, user, upload.id, capability(upload));
    const job = await env.DB.prepare(
      "SELECT j.state,j.epoch,i.status FROM library_jobs j JOIN library_items i ON i.node_id=j.node_id AND i.blob_id=j.blob_id WHERE j.node_id=?1",
    )
      .bind(node.id)
      .first();
    expect(job).toEqual({ state: "pending", epoch: 1, status: "pending" });
  });

  it("indexes deflated CBZ pages with bounded Range metadata, cover, CRC, and reading state", async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8, 9]);
    const archive = zipSync({ "10.png": second, "2.jpg": first }, { level: 6 });
    await seedBook("comic", "同人誌 vol.1.cbz", "application/zip", archive);
    const jobId = await enqueue("comic");
    await processLibraryJob(withImages(), jobId);
    await processLibraryJob(withImages(), jobId);

    const items = await listLibraryItems(env, "user");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nodeId: "comic",
      kind: "cbz",
      title: "同人誌 vol.1",
      pageCount: 2,
      status: "indexed",
      series: "",
    });
    const item = items[0];
    if (item === undefined) throw new Error("library item missing");
    const page0 = await serveLibraryPage(env, "user", item.id, 0, false);
    const page1 = await serveLibraryPage(env, "user", item.id, 1, false);
    expect(page0.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await page0.arrayBuffer())).toEqual(first);
    expect(new Uint8Array(await page1.arrayBuffer())).toEqual(second);
    const cover = await serveLibraryCover(env, "user", item.id, false);
    expect(cover.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(new Uint8Array([87, 69, 66, 80]));

    await saveReadingState(env, "user", item.id, { page: 1, mode: "spread", rtl: true });
    await expect(getLibraryItem(env, "user", item.id)).resolves.toMatchObject({
      item: { readingState: { page: 1, mode: "spread", rtl: true } },
    });

    const share = await createShare(env, user, {
      rootNodeId: "comic",
      kind: "link",
      mode: "download",
    });
    const secret = share.publicUrl?.split("#")[1];
    if (secret === undefined) throw new Error("share secret missing");
    const unlock = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/unlock`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.test.invalid",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ secret }),
      },
      withImages(),
    );
    const cookie = unlock.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const publicItem = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/library/comic`,
      { headers: { Cookie: cookie } },
      withImages(),
    );
    expect(publicItem.status).toBe(200);
    const publicPage = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/library/comic/pages/0`,
      { headers: { Cookie: cookie } },
      withImages(),
    );
    expect(publicPage.status).toBe(200);
    expect(new Uint8Array(await publicPage.arrayBuffer())).toEqual(first);
  });

  it("sanitizes EPUB XHTML into immutable script-free derivatives", async () => {
    const xhtml = new TextEncoder().encode(
      '<html><body><h1>Chapter</h1><script>alert(1)</script><a href="https://evil.invalid">External</a></body></html>',
    );
    const archive = zipSync(
      {
        "META-INF/container.xml": new TextEncoder().encode("<container/ >"),
        "OEBPS/chapter.xhtml": xhtml,
        "OEBPS/cover.png": new Uint8Array([1, 2, 3, 4]),
      },
      { level: 0 },
    );
    await seedBook("epub", "旅行記.epub", "application/epub+zip", archive);
    await processLibraryJob(withImages(), await enqueue("epub"));
    const item = (await listLibraryItems(env, "user"))[0];
    if (item === undefined) throw new Error("EPUB item missing");
    const details = await getLibraryItem(env, "user", item.id);
    expect(details.entries).toHaveLength(1);
    const entry = details.entries[0];
    if (entry === undefined) throw new Error("EPUB entry missing");
    const response = await serveEpubEntry(env, "user", item.id, entry.id, false);
    const sanitized = await response.text();
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("href=");
    expect(sanitized).toContain("Chapter");
  });

  it("indexes PDF as a bounded original-content reader item", async () => {
    await seedBook("pdf", "manual.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70]));
    await processLibraryJob(env, await enqueue("pdf"));
    expect((await listLibraryItems(env, "user"))[0]).toMatchObject({
      nodeId: "pdf",
      kind: "pdf",
      pageCount: null,
      status: "indexed",
    });
  });

  it("rejects dangerous paths, compression bombs, and unsupported RAR-family books", async () => {
    const dangerous = zipSync({ "../escape.jpg": new Uint8Array([1]) }, { level: 0 });
    await env.BLOBS.put("dangerous", dangerous);
    await expect(indexZipArchive(env.BLOBS, "dangerous", dangerous.byteLength)).rejects.toThrow(
      "archive_path_invalid",
    );

    const bomb = zipSync({ "bomb.jpg": new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
    await env.BLOBS.put("bomb", bomb);
    await expect(indexZipArchive(env.BLOBS, "bomb", bomb.byteLength)).rejects.toThrow(
      "unsupported_format",
    );

    await seedBook("rar", "legacy.cbr", "application/vnd.rar", new Uint8Array([82, 97, 114, 33]));
    const jobId = await enqueue("rar");
    await expect(processLibraryJob(withImages(), jobId)).rejects.toThrow("unsupported_format");
    const failed = await listLibraryItems(env, "user");
    expect(failed.find((item) => item.nodeId === "rar")).toMatchObject({
      status: "failed",
      errorCode: "unsupported_format",
    });
  });
});
