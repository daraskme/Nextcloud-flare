import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { processVideoOutbox } from "../../src/jobs/video";
import { VIDEO_METADATA_BYTES, VIDEO_METADATA_GENERATOR } from "../../src/media/video";
import { listAudio } from "../../src/services/audio";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

const text = new TextEncoder();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([value >>> 24, value >>> 16, value >>> 8, value]);
}

function box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = bytes(...payload);
  return bytes(u32(body.length + 8), text.encode(type), body);
}

function mp4(sampleType = "av01"): Uint8Array {
  const ftyp = box("ftyp", text.encode("av01"), u32(0), text.encode("av01"));
  const mvhd = new Uint8Array(20);
  mvhd.set(u32(1000), 12);
  mvhd.set(u32(9000), 16);
  const hdlr = new Uint8Array(12);
  hdlr.set(text.encode("vide"), 8);
  const visual = new Uint8Array(78);
  visual.set([0x07, 0x80, 0x04, 0x38], 24);
  const sample = box(
    sampleType,
    visual,
    ...(sampleType === "av01" ? [box("av1C", Uint8Array.from([0x81, 0x08, 0x40, 0]))] : []),
  );
  const stsd = box("stsd", new Uint8Array(4), u32(1), sample);
  const videoTrack = box("trak", box("mdia", box("hdlr", hdlr), box("minf", box("stbl", stsd))));
  const audioHandler = new Uint8Array(12);
  audioHandler.set(text.encode("soun"), 8);
  const audioStsd = box("stsd", new Uint8Array(4), u32(1), box("Opus"));
  const audioTrack = box(
    "trak",
    box("mdia", box("hdlr", audioHandler), box("minf", box("stbl", audioStsd))),
  );
  return bytes(ftyp, box("moov", box("mvhd", mvhd), videoTrack, audioTrack), box("mdat"));
}

function opusMp4(): Uint8Array {
  const ftyp = box("ftyp", text.encode("M4A "), u32(0), text.encode("isom"));
  const mvhd = new Uint8Array(20);
  mvhd.set(u32(1000), 12);
  mvhd.set(u32(9000), 16);
  const hdlr = new Uint8Array(12);
  hdlr.set(text.encode("soun"), 8);
  const dops = box("dOps", Uint8Array.from([0, 2, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 0]));
  const stsd = box("stsd", new Uint8Array(4), u32(1), box("Opus", new Uint8Array(28), dops));
  return bytes(
    ftyp,
    box(
      "moov",
      box("mvhd", mvhd),
      box("trak", box("mdia", box("hdlr", hdlr), box("minf", box("stbl", stsd)))),
    ),
    box("mdat"),
  );
}

function id(value: number): Uint8Array {
  const octets: number[] = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256))
    octets.unshift(remaining & 255);
  return Uint8Array.from(octets);
}

function size(value: number): Uint8Array {
  if (value < 127) return Uint8Array.from([0x80 | value]);
  if (value < 16_383) return Uint8Array.from([0x40 | (value >> 8), value]);
  throw new Error("fixture_element_too_large");
}

function element(elementId: number, payload: Uint8Array): Uint8Array {
  return bytes(id(elementId), size(payload.length), payload);
}

function webm(): Uint8Array {
  const header = element(0x1a45dfa3, element(0x4282, text.encode("webm")));
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 9000);
  const info = element(
    0x1549a966,
    bytes(element(0x2ad7b1, Uint8Array.from([0x0f, 0x42, 0x40])), element(0x4489, duration)),
  );
  const video = element(
    0xae,
    bytes(
      element(0x83, Uint8Array.of(1)),
      element(0x86, text.encode("V_AV1")),
      element(0x63a2, Uint8Array.from([0x81, 0x08, 0x40, 0])),
      element(
        0xe0,
        bytes(
          element(0xb0, Uint8Array.from([0x07, 0x80])),
          element(0xba, Uint8Array.from([0x04, 0x38])),
        ),
      ),
    ),
  );
  const audio = element(
    0xae,
    bytes(element(0x83, Uint8Array.of(2)), element(0x86, text.encode("A_OPUS"))),
  );
  const tracks = element(0x1654ae6b, bytes(video, audio));
  return bytes(header, id(0x18538067), Uint8Array.of(0xff), info, tracks);
}

function opusWebm(): Uint8Array {
  const header = element(0x1a45dfa3, element(0x4282, text.encode("webm")));
  const opusHead = Uint8Array.from([
    ...text.encode("OpusHead"),
    1,
    2,
    0,
    0,
    0x80,
    0xbb,
    0,
    0,
    0,
    0,
    0,
  ]);
  const audio = element(
    0xae,
    bytes(
      element(0x83, Uint8Array.of(2)),
      element(0x86, text.encode("A_OPUS")),
      element(0x63a2, opusHead),
    ),
  );
  return bytes(header, id(0x18538067), Uint8Array.of(0xff), element(0x1654ae6b, audio));
}

function corruptMarker(data: Uint8Array, marker: string): Uint8Array {
  const encoded = text.encode(marker);
  const at = data.findIndex((_, index) =>
    encoded.every((value, offset) => data[index + offset] === value),
  );
  if (at < 0) throw new Error("missing_fixture_marker");
  data[at] = 0;
  return data;
}

function opusOgg(): Uint8Array {
  // The complete identification page from a real encoded Ogg Opus fixture.
  const page =
    "4f6767530002000000000000000012bbf357000000005b8011dc01134f707573486561640101380180bb0000000000";
  return Uint8Array.from(page.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function fixture(content: Uint8Array) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = await env.BLOBS.put(key, content);
  if (!object) throw new Error("r2_fixture_failed");
  const statements = f.statements.map((statement) =>
    statement.sql.startsWith("INSERT INTO blobs")
      ? {
          sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
            VALUES(?,?,?,?,?,'committed',?)`,
          values: [
            f.ids.blob,
            f.ids.user,
            key,
            content.length,
            `"b-${f.ids.blob}"`,
            Date.now() - 1000,
          ],
        }
      : statement,
  );
  await atomicBatch(env.DB, [
    ...statements,
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
      values: [f.ids.blob, content.length, object.etag, Date.now() - 500],
    },
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [
        f.ids.file,
        f.ids.space,
        searchName("File").textNorm,
        searchName("File").tokens,
        searchName("File").version,
      ],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  const eventId = crypto.randomUUID();
  const operandsJson = JSON.stringify({ parentId: f.ids.folder, nodeId: f.ids.file });
  const resultJson = JSON.stringify({ status: 204, nodeId: f.ids.file });
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(
        op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,
        epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json
      ) VALUES(?,'user',?,?,?,'dav.put','committed','video',1,?,?,?,1,1,1,?,?)`,
      values: [
        eventId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        operandsJson,
        resultJson,
      ],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [eventId, f.ids.file],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.updated',?,'pending',1,1,1)",
      values: [eventId, eventId, f.ids.file],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();
  const queue = {
    send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }),
  };
  expect(await dispatchOutbox(mutationEnv(), queue, eventId, 1)).toBe("sent");
  return { ...f.ids, eventId, key, operandsJson, resultJson };
}

it.each([
  ["mp4", mp4()],
  ["webm", webm()],
] as const)(
  "projects bounded %s AV1 metadata and accepts duplicate delivery",
  async (container, data) => {
    const f = await fixture(data);
    try {
      expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
      expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
      expect(
        await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
          .bind(f.blob)
          .first("mime_sniffed"),
      ).toBe(`video/${container}`);
      expect(
        await env.DB.prepare(`SELECT blob_id AS blobId,generator_version AS generatorVersion,
        width,height,duration_ms AS durationMs,container,video_codec AS videoCodec,
        audio_codec AS audioCodec,codec_profile AS codecProfile,codec_level AS codecLevel,
        codec_tier AS codecTier,bit_depth AS bitDepth,projection_state AS projectionState,
        error_code AS errorCode FROM node_media WHERE node_id=?`)
          .bind(f.file)
          .first(),
      ).toEqual({
        blobId: f.blob,
        generatorVersion: VIDEO_METADATA_GENERATOR,
        width: 1920,
        height: 1080,
        durationMs: 9000,
        container,
        videoCodec: "av1",
        audioCodec: "opus",
        codecProfile: 0,
        codecLevel: 8,
        codecTier: "M",
        bitDepth: 10,
        projectionState: "ready",
        errorCode: null,
      });
    } finally {
      await env.BLOBS.delete(f.key);
    }
  },
);

it.each([
  ["mp4", opusMp4()],
  ["webm", opusWebm()],
  ["ogg", opusOgg()],
] as const)("projects audio-only %s Opus into the audio library", async (container, data) => {
  const f = await fixture(data);
  try {
    expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.blob)
        .first("mime_sniffed"),
    ).toBe(`audio/${container}`);
    expect(
      await env.DB.prepare("SELECT codec FROM node_audio WHERE node_id=?")
        .bind(f.file)
        .first("codec"),
    ).toBe("opus");
    const ring = await contentKeyRing("cursor", {
      cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    });
    const page = await listAudio(
      env.DB,
      { kind: "user", user_id: f.user, credential_id: f.credential, epoch: 1 },
      f.root,
      true,
      new AudioCursorTokens(ring),
    );
    expect(page.items).toEqual([
      expect.objectContaining({ id: f.file, codec: "opus", mime: `audio/${container}` }),
    ]);
  } finally {
    await env.BLOBS.delete(f.key);
  }
});

it.each([
  ["MP4 without dOps", corruptMarker(opusMp4(), "dOps")],
  ["WebM without OpusHead", corruptMarker(opusWebm(), "OpusHead")],
] as const)("keeps %s out of the audio library", async (_label, data) => {
  const f = await fixture(data);
  try {
    expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.blob)
        .first("mime_sniffed"),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM node_audio WHERE node_id=?")
        .bind(f.file)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.BLOBS.delete(f.key);
  }
});

it.each([
  ["unsupported", mp4("hvc1")],
  [
    "malformed",
    bytes(box("ftyp", text.encode("av01"), u32(0), text.encode("av01")), box("moov"), box("mdat")),
  ],
] as const)("records deterministic %s video projection outcomes", async (errorCode, data) => {
  const f = await fixture(data);
  try {
    expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.blob)
        .first("mime_sniffed"),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT projection_state AS state,error_code AS errorCode FROM node_media WHERE node_id=?",
      )
        .bind(f.file)
        .first(),
    ).toEqual({ state: "failed", errorCode });
  } finally {
    await env.BLOBS.delete(f.key);
  }
});

it("fences projection against the saved operation result", async () => {
  const f = await fixture(mp4());
  const token = crypto.randomUUID();
  await env.DB.prepare("UPDATE outbox SET claim_token=?,claim_expires_at=? WHERE outbox_id=?")
    .bind(token, Date.now() + 30_000, f.eventId)
    .run();
  const principal = {
    kind: "user" as const,
    user_id: f.user,
    credential_id: f.credential,
    epoch: 1,
  };
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.read",
    nodeId: f.file,
    spaceId: f.space,
  });
  try {
    await expect(
      processVideoOutbox(
        { ...mutationEnv(), BLOBS: env.BLOBS },
        {
          outboxId: f.eventId,
          outboxToken: token,
          epoch: 1,
          ownerId: f.user,
          nodeId: f.file,
          operationKind: "dav.put",
          operandsJson: f.operandsJson,
          resultJson: JSON.stringify({ status: 204, nodeId: crypto.randomUUID() }),
        },
        authorized,
        Date.now() + 20_000,
      ),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM node_media WHERE node_id=?")
        .bind(f.file)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.BLOBS.delete(f.key);
  }
});

it("deterministically rejects metadata beyond the bounded window", async () => {
  const oversized = new Uint8Array(VIDEO_METADATA_BYTES + 16);
  oversized.set(box("ftyp", text.encode("av01"), u32(0), text.encode("av01")));
  const f = await fixture(oversized);
  await env.DB.prepare(`INSERT INTO node_media(
    node_id,blob_id,generator_version,width,height,container,video_codec,
    codec_profile,codec_level,codec_tier,bit_depth
  ) VALUES(?,?,?,1,1,'mp4','av1',0,8,'M',8)`)
    .bind(f.file, f.blob, VIDEO_METADATA_GENERATOR)
    .run();
  try {
    expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
    expect(
      await env.DB.prepare(
        "SELECT projection_state AS state,error_code AS errorCode FROM node_media WHERE node_id=?",
      )
        .bind(f.file)
        .first(),
    ).toEqual({ state: "failed", errorCode: "oversized" });
  } finally {
    await env.BLOBS.delete(f.key);
  }
});
