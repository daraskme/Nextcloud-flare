import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { auditRestoredBlobBytes, S3BlobSource } from "../backup/blobAudit.mjs";
import { restoreGeneration } from "../backup/generation.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

const etag = "a".repeat(32);
const multipartEtag = `${"b".repeat(32)}-2`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = [];
const posixOnly = process.platform === "win32" ? test.skip : test;
const windowsOnly = process.platform === "win32" ? test : test.skip;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepared({ second = false, badKey = false, physical = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ncf-blob-audit-test-"));
  roots.push(root);
  const first = Buffer.from("abc");
  const generated = await fixtureGeneration(join(root, "generations"), 0, (db, ids) => {
    db.prepare("UPDATE blobs SET r2_etag=?,sha256_verified=? WHERE id=?").run(
      etag,
      sha(first),
      ids.blob,
    );
    if (physical)
      db.prepare("INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)").run(
        ids.blob,
        etag,
      );
    if (second) {
      const id = "second-b";
      db.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,r2_etag,state,created_at) VALUES(?,?,?,5,?,?,'committed',1)",
      ).run(id, ids.user, `u/${ids.user}/b/${id}`, '"second"', multipartEtag);
      db.prepare("INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,5,?,1)").run(
        id,
        multipartEtag,
      );
    }
    if (badKey) {
      db.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,r2_etag,state,created_at) VALUES(?,?,?,0,?,?,'committed',1)",
      ).run("bad-b", ids.user, `u/${ids.user}/b/../bad-b`, '"bad"', etag);
      db.prepare("INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,0,?,1)").run(
        "bad-b",
        etag,
      );
    }
  });
  const database = join(root, "restored.sqlite");
  await restoreGeneration({ directory: generated.directory, target: database });
  return { root, generation: generated.directory, database };
}

function sourceFor(bytesByKey, { responseEtag, advertisedSize, chunks = false } = {}) {
  const calls = [];
  return {
    calls,
    timeoutMs: 1000,
    async get(key, expectedEtag) {
      calls.push({ key, expectedEtag });
      const bytes = bytesByKey[key];
      assert.ok(bytes);
      const stream = chunks
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 2));
              controller.enqueue(bytes.subarray(2));
              controller.close();
            },
          })
        : bytes;
      return new Response(stream, {
        headers: {
          ETag: `"${responseEtag ?? expectedEtag}"`,
          "Content-Length": String(advertisedSize ?? bytes.length),
        },
      });
    },
  };
}

posixOnly(
  "copies single and chunked multipart originals, verifies bytes, and refuses overwrites",
  async () => {
    const input = await prepared({ second: true });
    const owner = "publication-u";
    const source = sourceFor(
      {
        [`u/${owner}/b/publication-b`]: Buffer.from("abc"),
        [`u/${owner}/b/second-b`]: Buffer.from("12345"),
      },
      { chunks: true },
    );
    const directory = join(input.root, "copy");
    const options = {
      generation: input.generation,
      database: input.database,
      directory,
      source,
      maxObjects: 2,
      maxBytes: 8,
    };
    const result = await auditRestoredBlobBytes(options);
    assert.equal(result.objects, 2);
    assert.equal(result.bytes, 8);
    assert.match(result.aggregateSha256, /^[a-f0-9]{64}$/);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const privateManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal((await stat(join(directory, "manifest.json"))).mode & 0o777, 0o600);
    assert.deepEqual(
      privateManifest.entries.map((entry) => entry.sha256),
      [sha("abc"), sha("12345")],
    );
    for (const entry of privateManifest.entries) {
      assert.equal((await stat(join(directory, entry.file))).mode & 0o777, 0o600);
      assert.equal(sha(await readFile(join(directory, entry.file))), entry.sha256);
    }
    await assert.rejects(auditRestoredBlobBytes(options), { code: "EEXIST" });
    assert.equal((await readdir(join(directory, "objects"))).length, 2);
  },
);

posixOnly(
  "rejects ETag, length, digest and total-limit mismatches without publishing partial copies",
  async () => {
    const input = await prepared();
    const key = "u/publication-u/b/publication-b";
    const base = {
      generation: input.generation,
      database: input.database,
      maxObjects: 1,
      maxBytes: 3,
    };
    for (const [name, source, code] of [
      [
        "etag",
        sourceFor({ [key]: Buffer.from("abc") }, { responseEtag: "f".repeat(32) }),
        "backup_blob_etag_mismatch",
      ],
      [
        "length",
        sourceFor({ [key]: Buffer.from("ab") }, { advertisedSize: 3 }),
        "backup_blob_size_mismatch",
      ],
      ["digest", sourceFor({ [key]: Buffer.from("abd") }), "backup_blob_digest_mismatch"],
    ]) {
      const directory = join(input.root, name);
      await assert.rejects(auditRestoredBlobBytes({ ...base, directory, source }), {
        message: code,
      });
      await assert.rejects(stat(directory), { code: "ENOENT" });
    }
    const limited = sourceFor({ [key]: Buffer.from("abc") });
    await assert.rejects(
      auditRestoredBlobBytes({
        ...base,
        directory: join(input.root, "limit"),
        source: limited,
        maxBytes: 2,
      }),
      { message: "backup_blob_limit_exceeded" },
    );
    assert.equal(limited.calls.length, 0);
  },
);

posixOnly(
  "rejects noncanonical paths and missing physical observations before contacting R2",
  async () => {
    for (const [name, options, code] of [
      ["path", { badKey: true }, "backup_blob_key_mismatch"],
      ["physical", { physical: false }, "backup_blob_storage_mismatch"],
    ]) {
      const input = await prepared(options);
      const source = {
        get() {
          throw new Error("should_not_fetch");
        },
      };
      await assert.rejects(
        auditRestoredBlobBytes({
          generation: input.generation,
          database: input.database,
          directory: join(input.root, name),
          source,
          maxObjects: 2,
          maxBytes: 3,
        }),
        { message: code },
      );
    }
  },
);

posixOnly("rejects a restored SQLite from another verified generation", async () => {
  const first = await prepared();
  const second = await prepared();
  let contacted = false;
  await assert.rejects(
    auditRestoredBlobBytes({
      generation: first.generation,
      database: second.database,
      directory: join(first.root, "wrong-generation"),
      source: {
        get() {
          contacted = true;
        },
      },
      maxObjects: 1,
      maxBytes: 3,
    }),
    { message: "backup_blob_database_mismatch" },
  );
  assert.equal(contacted, false);
});

windowsOnly(
  "refuses blob audit when Windows cannot attest private SQLite permissions",
  async () => {
    const input = await prepared();
    const mode = (await stat(input.database)).mode & 0o777;
    assert.notEqual(mode & 0o077, 0);
    let contacted = false;
    await assert.rejects(
      auditRestoredBlobBytes({
        generation: input.generation,
        database: input.database,
        directory: join(input.root, "copy"),
        source: {
          get() {
            contacted = true;
          },
        },
        maxObjects: 1,
        maxBytes: 3,
      }),
      { message: "backup_blob_database_not_private" },
    );
    assert.equal(contacted, false);
  },
);

test("S3 source signs only fixed-bucket GET and rejects traversal before transport", async () => {
  const env = {
    R2_INVENTORY_ACCOUNT_ID: "a".repeat(32),
    R2_INVENTORY_BUCKET: "private-blobs",
    R2_INVENTORY_ACCESS_KEY_ID: "b".repeat(32),
    R2_INVENTORY_SECRET_ACCESS_KEY: "c".repeat(64),
  };
  const requests = [];
  const source = new S3BlobSource(env, {
    fetch: async (request) => {
      requests.push(request);
      return new Response(Buffer.from("abc"), { headers: { ETag: `"${etag}"` } });
    },
  });
  await assert.rejects(source.get("u/x/b/../other", etag, new AbortController().signal), {
    message: "backup_blob_key_mismatch",
  });
  assert.equal(requests.length, 0);
  await source.get("u/x/b/y", etag, new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].url,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-blobs/u/x/b/y`,
  );
  assert.equal(requests[0].headers.get("If-Match"), `"${etag}"`);
  assert.ok(requests[0].headers.has("Authorization"));
  assert.throws(() => new S3BlobSource({ ...env, R2_INVENTORY_BUCKET: "other/path" }), {
    message: "backup_blob_source_unconfigured",
  });
});
