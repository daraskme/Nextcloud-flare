import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { AUDIO_GENERATOR_VERSION } from "../../src/media/audio";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

const text = new TextEncoder();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function synchsafe(value: number): Uint8Array {
  return Uint8Array.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function id3(title: string, artist: string, album: string): Uint8Array {
  const frames = [
    ["TIT2", title],
    ["TPE1", artist],
    ["TALB", album],
  ].map(([id, value]) => {
    const body = Uint8Array.from([3, ...text.encode(value)]);
    const bytes = new Uint8Array(10 + body.length);
    bytes.set(text.encode(id));
    bytes.set(synchsafe(body.length), 4);
    bytes.set(body, 10);
    return bytes;
  });
  const payloadBytes = frames.reduce((total, frame) => total + frame.length, 0);
  const bytes = new Uint8Array(10 + payloadBytes + 4);
  bytes.set(text.encode("ID3"));
  bytes[3] = 4;
  bytes.set(synchsafe(payloadBytes), 6);
  let offset = 10;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.length;
  }
  bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
  return bytes;
}

async function fixture(
  content: Uint8Array,
  options: {
    copy?: boolean;
    put?: boolean;
    storage?: boolean;
    storageEtag?: string;
    uploadEvent?: "created" | "updated";
  } = {},
) {
  const prefix = crypto.randomUUID();
  const f = foundationFixture(prefix, Date.now() - 1000);
  const sourceNodeId = `${prefix}-source`;
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object =
    options.put === false ? null : await env.BLOBS.put(key, content, { httpMetadata: {} });
  const base = f.statements.map((statement) =>
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
  await atomicBatch(env.DB, base);
  const search = searchName("File");
  await atomicBatch(env.DB, [
    ...(options.copy
      ? [
          {
            sql: `INSERT INTO nodes(
              id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at
            ) VALUES(?,?,?,?,'Source','source','file',?,?,?)`,
            values: [
              sourceNodeId,
              f.ids.space,
              f.ids.user,
              f.ids.folder,
              f.ids.blob,
              Date.now() - 1000,
              Date.now() - 1000,
            ],
          },
        ]
      : []),
    ...(options.storage === false
      ? []
      : [
          {
            sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
            values: [
              f.ids.blob,
              content.length,
              options.storageEtag ?? object?.etag ?? "missing-etag",
              Date.now() - 500,
            ],
          },
        ]),
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.file, f.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  const eventId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(
        op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,
        epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json
      ) VALUES(?,'user',?,?,?,?, 'committed','audio',1,?,?,?,1,1,1,?,?)`,
      values: [
        eventId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        options.copy ? "node.copy" : options.uploadEvent ? "upload.complete" : "dav.put",
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        JSON.stringify(
          options.copy
            ? { parentId: f.ids.folder, sourceNodeId }
            : options.uploadEvent === "created"
              ? { parentId: f.ids.folder, uploadId: `${prefix}-upload` }
              : { parentId: f.ids.folder, nodeId: f.ids.file },
        ),
        JSON.stringify({
          status: options.copy || options.uploadEvent === "created" ? 201 : 204,
          nodeId: f.ids.file,
        }),
      ],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [eventId, f.ids.file],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,?,?,'pending',1,1,1)",
      values: [
        eventId,
        eventId,
        options.copy || options.uploadEvent === "created" ? "node.created" : "node.updated",
        f.ids.file,
      ],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();
  const queue = {
    send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }),
  };
  expect(await dispatchOutbox(mutationEnv(), queue, eventId, 1)).toBe("sent");
  return { ...f.ids, eventId, key, object };
}

async function seedStaleMetadata(ids: Awaited<ReturnType<typeof fixture>>) {
  const old = searchName("File Old title Old artist Old album");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,title_extracted,artist_extracted,album_extracted) VALUES(?,?,?,'mp3','Old title','Old artist','Old album')",
      values: [ids.file, ids.blob, "old-generator"],
    },
    {
      sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
        SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
      values: [ids.file],
    },
    {
      sql: "UPDATE search_index SET text_norm=?,tokens=?,normalization_version=? WHERE node_id=?",
      values: [old.textNorm, old.tokens, old.version, ids.file],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [ids.file],
    },
  ]);
}

it("indexes byte-recognized audio metadata atomically and accepts duplicate delivery", async () => {
  const f = await fixture(id3("Bounded title", "Bounded artist", "Bounded album"));
  await env.DB.prepare(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,track_number,disc_number) VALUES(?,?,?,'mp3',9,2)",
  )
    .bind(f.file, f.blob, "old-generator")
    .run();
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
      .bind(f.blob)
      .first("mime_sniffed"),
  ).toBe("audio/mpeg");
  expect(
    await env.DB.prepare(
      "SELECT blob_id,generator_version,codec,title_extracted,artist_extracted,album_extracted,duration_ms,track_number,disc_number FROM node_audio WHERE node_id=?",
    )
      .bind(f.file)
      .first(),
  ).toEqual({
    blob_id: f.blob,
    generator_version: AUDIO_GENERATOR_VERSION,
    codec: "mp3",
    title_extracted: "Bounded title",
    artist_extracted: "Bounded artist",
    album_extracted: "Bounded album",
    duration_ms: null,
    track_number: null,
    disc_number: null,
  });
  expect(
    await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
      .bind(f.file)
      .first("text_norm"),
  ).toBe("file bounded title bounded artist bounded album");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM search_fts WHERE rowid=(SELECT rowid FROM search_index WHERE node_id=?) AND search_fts MATCH 'bounded'",
    )
      .bind(f.file)
      .first("n"),
  ).toBe(1);
});

it.each(["created", "updated"] as const)(
  "classifies %s upload completion from verified media bytes",
  async (uploadEvent) => {
    const f = await fixture(id3("Uploaded", "Artist", "Album"), { uploadEvent });
    try {
      expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
      expect(
        await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
          .bind(f.blob)
          .first("mime_sniffed"),
      ).toBe("audio/mpeg");
      expect(
        await env.DB.prepare("SELECT codec FROM node_audio WHERE node_id=?")
          .bind(f.file)
          .first("codec"),
      ).toBe("mp3");
    } finally {
      await env.BLOBS.delete(f.key);
    }
  },
);

it.each([
  ["unsupported", new Uint8Array(256)],
  [
    "malformed",
    Uint8Array.from([...text.encode("ID3"), 4, 0, 0, 0x80, 0, 0, 0, ...new Uint8Array(32)]),
  ],
] as const)(
  "completes deterministic %s content by removing stale metadata",
  async (_kind, content) => {
    const f = await fixture(content);
    await seedStaleMetadata(f);
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
    expect(
      await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
        .bind(f.file)
        .first("text_norm"),
    ).toBe("file");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM search_fts WHERE rowid=(SELECT rowid FROM search_index WHERE node_id=?) AND search_fts MATCH 'old'",
      )
        .bind(f.file)
        .first("n"),
    ).toBe(0);
  },
);

it.each(["missing", "identity", "deadline"] as const)(
  "retries transient %s outcomes without metadata or FTS writes",
  async (condition) => {
    const f = await fixture(id3("Transient", "Artist", "Album"), {
      put: condition !== "missing",
      ...(condition === "identity" ? { storageEtag: "wrong-etag" } : {}),
    });
    expect(
      await consumeOutbox(
        mutationEnv(),
        f.eventId,
        condition === "deadline" ? Date.now() + 5000 : Date.now() + 25_000,
      ),
    ).toBe("retry");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM node_audio WHERE node_id=?")
        .bind(f.file)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
        .bind(f.file)
        .first("text_norm"),
    ).toBe("file");
    expect(
      await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?")
        .bind(f.eventId)
        .first("state"),
    ).toBe("sent");
  },
);

// R2: a copied file shares the source blob, so its node.created event can be
// indexed in place — the audio gate now accepts node.copy/dav.copy ops.
it("indexes a logical copy from the shared source object", async () => {
  const f = await fixture(id3("Copied title", "Copied artist", "Copied album"), {
    copy: true,
  });
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(
    await env.DB.prepare(
      "SELECT title_extracted,artist_extracted,album_extracted FROM node_audio WHERE node_id=?",
    )
      .bind(f.file)
      .first(),
  ).toMatchObject({
    title_extracted: "Copied title",
    artist_extracted: "Copied artist",
    album_extracted: "Copied album",
  });
});

// R2: a copy whose shared blob has no active storage observation completes
// without indexing — like a non-audio event — rather than wedging the outbox
// on a blob that can never be inspected.
it("completes a copy event without indexing when the shared blob is unobserved", async () => {
  const f = await fixture(id3("Copied title", "Copied artist", "Copied album"), {
    copy: true,
    storage: false,
  });
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM node_audio WHERE node_id=?")
      .bind(f.file)
      .first("n"),
  ).toBe(0);
});

it("fences an extraction result when the node changes to a newer blob", async () => {
  const f = await fixture(id3("Stale title", "Artist", "Album"));
  const newer = `${f.blob}-newer`;
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,1,?,'committed',1)",
  )
    .bind(newer, f.user, `${f.key}-newer`, `"b-${newer}"`)
    .run();
  let changed = false;
  const source = mutationEnv();
  const bucket = {
    async get(...args: Parameters<R2Bucket["get"]>) {
      const object = await env.BLOBS.get(...args);
      if (!changed) {
        changed = true;
        await env.DB.prepare("UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?")
          .bind(newer, f.file)
          .run();
        await env.DB.prepare("UPDATE search_index SET revision=revision+1 WHERE node_id=?")
          .bind(f.file)
          .run();
      }
      return object;
    },
  } as unknown as R2Bucket;
  expect(await consumeOutbox({ ...source, BLOBS: bucket }, f.eventId)).toBe("retry");
  expect(
    await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(f.file)
      .first("current_blob_id"),
  ).toBe(newer);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM node_audio WHERE node_id=?")
      .bind(f.file)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
      .bind(f.file)
      .first("text_norm"),
  ).toBe("file");
});
