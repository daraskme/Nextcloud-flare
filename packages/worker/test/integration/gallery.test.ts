import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import type { Env } from "../../src/env.js";
import { app } from "../../src/index.js";
import { enqueueMediaJob, processMediaJob } from "../../src/jobs/media.js";
import { serveThumbnail } from "../../src/media/images/derivatives.js";
import { assertGalleryCandidateLimit, listGallery } from "../../src/services/gallery.js";
import { createShare } from "../../src/services/shares.js";
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

async function seedGallery(): Promise<void> {
  const now = Date.now();
  const video = new Uint8Array(1024);
  video.set([9, 10, 11, 12]);
  await Promise.all([
    env.BLOBS.put("u/user/b/image-a", new Uint8Array([1, 2, 3, 4])),
    env.BLOBS.put("u/user/b/image-b", new Uint8Array([5, 6, 7, 8])),
    env.BLOBS.put("u/user/b/video", video),
    env.BLOBS.put("u/user/b/queued", new Uint8Array([13, 14, 15, 16])),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('gallery','space','user','root','Gallery','gallery','folder',NULL,1,?1,?1,0)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('nested','space','user','gallery','Nested','nested','folder',NULL,1,?1,?1,0)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES('image-a','user','u/user/b/image-a',4,'\"b-image-a\"','image/jpeg',1,'committed',?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES('image-b','user','u/user/b/image-b',4,'\"b-image-b\"','image/png',1,'committed',?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES('video','user','u/user/b/video',1024,'\"b-video\"','video/mp4',1,'committed',?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES('queued','user','u/user/b/queued',4,'\"b-queued\"','image/png',1,'committed',?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('photo-a','space','user','gallery','a.jpg','a.jpg','file','image-a',1,?1,?2,0)",
    ).bind(now, now - 1000),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('photo-b','space','user','nested','b.png','b.png','file','image-b',1,?1,?2,0)",
    ).bind(now, now - 2000),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('movie','space','user','gallery','movie.mp4','movie.mp4','file','video',1,?1,?2,0)",
    ).bind(now, now - 3000),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('queued-photo','space','user','gallery','queued.png','queued.png','file','queued',1,?1,?2,0)",
    ).bind(now, now - 4000),
    env.DB.prepare(
      "INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,duration_ms,orientation,dominant_color,camera_make,camera_model) VALUES('photo-a','image-a','image-v1',1200,800,?1,NULL,1,NULL,NULL,NULL)",
    ).bind(Date.UTC(2025, 5, 1)),
    env.DB.prepare(
      "INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,duration_ms,orientation,dominant_color,camera_make,camera_model) VALUES('photo-b','image-b','image-v1',800,1200,?1,NULL,1,NULL,NULL,NULL)",
    ).bind(Date.UTC(2024, 5, 1)),
  ]);
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
        response: () => new Response(new Uint8Array([82, 73, 70, 70])),
        contentType: () => "image/webp",
        image: () => {
          const body = new Response(new Uint8Array([82, 73, 70, 70])).body;
          if (body === null) throw new Error("missing body");
          return body;
        },
      });
    },
  };
  return {
    info() {
      return Promise.resolve({
        format: "image/png" as const,
        fileSize: 4,
        width: 800,
        height: 600,
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

beforeEach(async () => {
  await seedFoundation();
  await seedGallery();
});

describe("Phase 8A gallery", () => {
  it("uses recursive signed keyset pages and enforces the candidate gate", async () => {
    const first = await listGallery(env, {
      userId: "user",
      rootId: "gallery",
      recursive: true,
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const nextCursor = first.nextCursor;
    if (nextCursor === null) throw new Error("missing cursor");
    const second = await listGallery(env, {
      userId: "user",
      rootId: "gallery",
      recursive: true,
      cursor: nextCursor,
      limit: 2,
    });
    expect(second.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(first.items.map((item) => item.id)),
    );
    expect([...first.items, ...second.items]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "photo-a", width: 1200, mediaKind: "image" }),
        expect.objectContaining({ id: "photo-b", height: 1200, mediaKind: "image" }),
        expect.objectContaining({ id: "movie", mediaKind: "video" }),
      ]),
    );
    await expect(
      listGallery(env, {
        userId: "user",
        rootId: "gallery",
        recursive: true,
        cursor: `${first.nextCursor ?? ""}x`,
      }),
    ).rejects.toThrow("cursor");
    await expect(assertGalleryCandidateLimit(env, "gallery", 3)).rejects.toThrow(
      "gallery_scope_too_large",
    );
  });

  it("extracts current image metadata and publishes claimed Images derivatives", async () => {
    const sent: string[] = [];
    const jobId = await enqueueMediaJob(env, "queued-photo", "metadata", (message) => {
      sent.push(message.jobId);
      return Promise.resolve();
    });
    expect(jobId).not.toBeNull();
    expect(sent).toEqual([jobId]);

    const before = await serveThumbnail(env, "user", "queued-photo", "md768", false);
    expect(before.headers.get("X-NCF-Placeholder")).toBe("1");
    expect(await before.text()).not.toContain("13,14,15,16");

    await processMediaJob(withImages(), jobId ?? "");
    await processMediaJob(withImages(), jobId ?? "");
    const media = await env.DB.prepare(
      "SELECT blob_id blobId,generator_version generatorVersion,width,height,taken_at takenAt,camera_make cameraMake,camera_model cameraModel FROM node_media WHERE node_id='queued-photo'",
    ).first();
    expect(media).toEqual({
      blobId: "queued",
      generatorVersion: "image-v1",
      width: 800,
      height: 600,
      takenAt: null,
      cameraMake: null,
      cameraModel: null,
    });
    const derivatives = await env.DB.prepare(
      "SELECT variant,state,r2_key r2Key FROM derivative_results WHERE blob_id='queued' ORDER BY variant",
    ).all<{ variant: string; state: string; r2Key: string }>();
    expect(derivatives.results).toEqual([
      expect.objectContaining({ variant: "md768", state: "published" }),
      expect.objectContaining({ variant: "sm256", state: "published" }),
    ]);
    const thumbnail = await serveThumbnail(env, "user", "queued-photo", "md768", false);
    expect(thumbnail.headers.get("Content-Type")).toBe("image/webp");
    await expect(thumbnail.arrayBuffer()).resolves.toHaveProperty("byteLength", 4);
  });

  it("keeps video content on the existing single Range path", async () => {
    const response = await import("../../src/services/content.js").then(({ serveNodeContent }) =>
      serveNodeContent(
        env,
        "user",
        "movie",
        new Request("https://app.test.invalid/video", { headers: { Range: "bytes=1-2" } }),
      ),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 1-2/1024");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([10, 11]));
  });

  it("keeps public gallery thumbnails and video inside the share capability", async () => {
    const share = await createShare(env, user, {
      rootNodeId: "gallery",
      kind: "link",
      mode: "download",
    });
    const secret = share.publicUrl?.split("#")[1];
    if (secret === undefined) throw new Error("missing share secret");
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
      env,
    );
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("Set-Cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("missing share cookie");
    const gallery = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/gallery`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(gallery.status).toBe(200);
    const page: unknown = await gallery.json();
    if (
      typeof page !== "object" ||
      page === null ||
      !("items" in page) ||
      !Array.isArray(page.items)
    ) {
      throw new Error("invalid gallery response");
    }
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "movie",
          thumbUrl: `/api/v1/public/shares/${share.id}/thumb/movie`,
          contentUrl: `/api/v1/public/shares/${share.id}/content/movie`,
        }),
      ]),
    );
    const thumbnail = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/thumb/movie`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("X-NCF-Placeholder")).toBe("1");
    await thumbnail.arrayBuffer();
    const video = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/content/movie`,
      { headers: { Cookie: cookie, Range: "bytes=1-2" } },
      env,
    );
    expect(video.status).toBe(206);
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(new Uint8Array([10, 11]));
  });
});
