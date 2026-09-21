import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import type { Env } from "../../src/env.js";
import { app } from "../../src/index.js";
import { enqueueAudioJob, processAudioJob } from "../../src/jobs/audio.js";
import { listTracks, savePlaybackState, serveAudioCover } from "../../src/services/audio.js";
import { serveNodeContent } from "../../src/services/content.js";
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

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function be32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function frame(id: string, value: Uint8Array): Uint8Array {
  return concat(text(id), be32(value.byteLength), new Uint8Array(2), value);
}

function mp3(): Uint8Array {
  const frames = concat(
    frame("TIT2", concat(new Uint8Array([3]), text("Track Two"))),
    frame("TPE1", concat(new Uint8Array([3]), text("Artist"))),
    frame("TALB", concat(new Uint8Array([3]), text("Album"))),
    frame("TRCK", concat(new Uint8Array([3]), text("2"))),
    frame(
      "APIC",
      concat(new Uint8Array([3]), text("image/jpeg"), new Uint8Array([0, 3, 0, 0xff, 0xd8, 0xff])),
    ),
  );
  const header = concat(text("ID3"), new Uint8Array([3, 0, 0]), synchsafe(frames.byteLength));
  const audio = new Uint8Array(16_000);
  audio.set([0xff, 0xfb, 0x90, 0x64]);
  return concat(header, frames, audio);
}

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
      return Promise.resolve({ format: "jpeg" as const, fileSize: 4, width: 512, height: 512 });
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
  const now = Date.now();
  const bytes = mp3();
  await env.BLOBS.put("u/user/b/audio-blob", bytes);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('album','space','user','root','Album','album','folder',NULL,1,?1,?1,0)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,ref_count,state,created_at) VALUES('audio-blob','user','u/user/b/audio-blob',?1,'\"b-audio-blob\"','audio/mpeg',1,'committed',?2)",
    ).bind(bytes.byteLength, now),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('track','space','user','album','02 Track.mp3','02 track.mp3','file','audio-blob',1,?1,?1,0)",
    ).bind(now),
  ]);
});

describe("Phase 8C audio", () => {
  it("creates the audio job durably in the upload mutation", async () => {
    const bytes = mp3();
    const upload = await createUpload(env, user, {
      parentId: "root",
      name: "queued.mp3",
      declaredSize: bytes.byteLength,
      mode: "single",
    });
    await putSingleContent(env, user, upload.id, capability(upload), body(bytes), bytes.byteLength);
    const node = await completeUpload(env, user, upload.id, capability(upload));
    await expect(
      env.DB.prepare("SELECT state,epoch FROM audio_jobs WHERE node_id=?1").bind(node.id).first(),
    ).resolves.toEqual({ state: "pending", epoch: 1 });
  });

  it("extracts bounded tags and cover, orders album tracks, and saves blob-bound position", async () => {
    const sent: string[] = [];
    const jobId = await enqueueAudioJob(env, "track", (message) => {
      sent.push(message.jobId);
      return Promise.resolve();
    });
    expect(sent).toEqual([jobId]);
    await processAudioJob(withImages(), jobId ?? "");
    await processAudioJob(withImages(), jobId ?? "");

    const album = await listTracks(env, "user", "album");
    expect(album.tracks).toHaveLength(1);
    expect(album.tracks[0]).toMatchObject({
      nodeId: "track",
      title: "Track Two",
      artist: "Artist",
      album: "Album",
      trackNo: 2,
      codec: "mp3",
      bitrate: 128_000,
    });
    const cover = await serveAudioCover(env, "user", "track", false);
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(new Uint8Array([87, 69, 66, 80]));

    await savePlaybackState(env, "user", "track", 12_345);
    expect((await listTracks(env, "user", "album")).tracks[0]?.positionMs).toBe(12_345);
    const range = await serveNodeContent(
      env,
      "user",
      "track",
      new Request("https://app.test.invalid/audio", { headers: { Range: "bytes=0-2" } }),
    );
    expect(range.status).toBe(206);
  });

  it("serves shared album metadata and Range audio without applying private auth", async () => {
    const jobId = await enqueueAudioJob(env, "track", () => Promise.resolve());
    await processAudioJob(withImages(), jobId ?? "");
    const share = await createShare(env, user, {
      rootNodeId: "album",
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
    const tracks = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/tracks`,
      { headers: { Cookie: cookie } },
      withImages(),
    );
    expect(tracks.status).toBe(200);
    await expect(tracks.json()).resolves.toMatchObject({
      tracks: [
        {
          nodeId: "track",
          contentUrl: `/api/v1/public/shares/${share.id}/content/track`,
        },
      ],
    });
    const content = await app.request(
      `https://app.test.invalid/api/v1/public/shares/${share.id}/content/track`,
      { headers: { Cookie: cookie, Range: "bytes=0-2" } },
      withImages(),
    );
    expect(content.status).toBe(206);
  });
});
