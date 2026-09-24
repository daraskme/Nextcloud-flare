import { cp, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { verifyGeneration } from "../backup/generation.mjs";
import { CHUNK_BYTES, digest, manifestKey, partKey } from "../backup/objectStore.mjs";
import {
  downloadGeneration,
  encode,
  ensureObject,
  fileChunks,
  publishGeneration,
} from "../backup/publication.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

let directory, artifact, store, objects, events;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "publication-test-"));
  artifact = await fixtureGeneration(join(directory, "source"));
  objects = new Map();
  events = [];
  store = {
    get: async (key, limit) => {
      events.push(["get", key]);
      const value = objects.get(key);
      if (value && value.length > limit) throw new Error("backup_object_size");
      return value ? Buffer.from(value) : null;
    },
    put: async (key, value) => {
      events.push(["put", key]);
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(value));
      return true;
    },
  };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const publish = () => publishGeneration({ directory: artifact.directory, store });
const download = (extra = {}) =>
  downloadGeneration({
    directory: join(directory, "download"),
    id: artifact.manifest.generation.id,
    store,
    ...extra,
  });

it("publishes only a verified generation, commits manifest last and downloads identical SQL through the restore gate", async () => {
  const receipt = await publish();
  expect(receipt.parts).toBe(1);
  expect(events.filter(([kind]) => kind === "put").at(-1)[1]).toBe(receipt.key);
  expect(digest(objects.get(receipt.key))).toBe(receipt.sha256);
  const result = await download({ expectedSha256: receipt.sha256 });
  expect(result.manifest).toEqual(artifact.manifest);
  expect(await readFile(join(result.directory, "data.sql"))).toEqual(
    await readFile(join(artifact.directory, "data.sql")),
  );
  expect(await verifyGeneration(result.directory)).toEqual(artifact.manifest);
});
it("repeated publication reads back all objects without overwriting them", async () => {
  const first = await publish(),
    saved = new Map(objects);
  events.length = 0;
  expect(await publish()).toEqual(first);
  expect(events.some(([kind]) => kind === "put")).toBe(false);
  expect(objects).toEqual(saved);
});
it.each(["part", "manifest"])(
  "reconciles a lost %s PUT acknowledgement only from matching bytes",
  async (kind) => {
    const put = store.put;
    store.put = async (key, value) => {
      await put(key, value);
      if (key.endsWith("manifest.json") === (kind === "manifest")) throw new Error("lost_ack");
    };
    const receipt = await publish();
    expect(objects.has(receipt.key)).toBe(true);
  },
);
it("retains partial immutable objects on read failure and resumes without writing that part twice", async () => {
  const get = store.get;
  let fail = true;
  store.get = async (key, limit) => {
    if (fail && key.includes("/parts/") && objects.has(key)) {
      fail = false;
      throw new Error("read_unavailable");
    }
    return get(key, limit);
  };
  await expect(publish()).rejects.toThrow("read_unavailable");
  expect(objects.has(manifestKey(artifact.manifest.generation.id))).toBe(false);
  const puts = events.filter(([kind]) => kind === "put").length;
  await publish();
  expect(events.filter(([kind]) => kind === "put")).toHaveLength(puts + 1);
});
it("does not publish a manifest after an unresolved write failure", async () => {
  store.put = async () => {
    throw new Error("offline");
  };
  await expect(publish()).rejects.toThrow("backup_store_write_unknown");
  expect(objects.size).toBe(0);
});
it("never overwrites conflicting data at a content-addressed part key", async () => {
  const bytes = Buffer.from("expected"),
    key = partKey(artifact.manifest.generation.id, 0, digest(bytes));
  objects.set(key, Buffer.from("different"));
  await expect(ensureObject(store, key, bytes)).rejects.toThrow();
  expect(events.some(([kind]) => kind === "put")).toBe(false);
});
it("rejects an invalid local generation before any R2 request", async () => {
  await writeFile(join(artifact.directory, "data.sql"), "DROP TABLE users;");
  await expect(publish()).rejects.toThrow();
  expect(events).toEqual([]);
});
it("does not commit when the local SQL changes during upload", async () => {
  const put = store.put;
  store.put = async (key, bytes) => {
    const result = await put(key, bytes);
    await writeFile(join(artifact.directory, "data.sql"), "changed");
    return result;
  };
  await expect(publish()).rejects.toThrow("backup_file_changed");
  expect(objects.has(manifestKey(artifact.manifest.generation.id))).toBe(false);
});
it("concurrent publications with different manifests cannot replace the winning generation", async () => {
  const other = join(directory, "other");
  await cp(artifact.directory, other, { recursive: true });
  await writeFile(
    join(other, "manifest.json"),
    JSON.stringify({ ...artifact.manifest, capturedAt: artifact.manifest.capturedAt + 1 }),
  );
  const results = await Promise.allSettled([
    publish(),
    publishGeneration({ directory: other, store }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const saved = objects.get(manifestKey(artifact.manifest.generation.id));
  await download();
  expect(objects.get(manifestKey(artifact.manifest.generation.id))).toEqual(saved);
});
it.each(["missing", "corrupt", "hash", "id", "part_size", "key", "schema"])(
  "rejects damaged publication %s without leaving a ready local generation",
  async (kind) => {
    const receipt = await publish(),
      wrapper = JSON.parse(objects.get(receipt.key));
    const key = partKey(receipt.id, 0, wrapper.parts[0].sha256);
    if (kind === "missing") objects.delete(key);
    if (kind === "corrupt") objects.set(key, Buffer.from("corrupt"));
    if (kind === "id") wrapper.manifest.generation.id = "00000000-0000-0000-0000-000000000000";
    if (kind === "part_size") wrapper.parts[0].bytes++;
    if (kind === "key") wrapper.parts[0].key = "sys/epoch/1.json";
    if (kind === "schema") wrapper.manifest.schema.sha256 = "0".repeat(64);
    if (["id", "part_size", "key", "schema"].includes(kind))
      objects.set(receipt.key, encode(wrapper));
    await expect(
      download(kind === "hash" ? { expectedSha256: "0".repeat(64) } : {}),
    ).rejects.toThrow();
    expect(
      (await readdir(directory)).includes("download")
        ? await readdir(join(directory, "download"))
        : [],
    ).toEqual([]);
  },
);
it("does not replace an existing downloaded generation", async () => {
  await publish();
  const result = await download();
  const saved = await readFile(join(result.directory, "manifest.json"));
  await expect(download()).rejects.toThrow("backup_destination_exists");
  expect(await readFile(join(result.directory, "manifest.json"))).toEqual(saved);
});
it("handles short filesystem reads without shifting chunk boundaries", async () => {
  const bytes = Buffer.from("abcdefghijkl"),
    read = async (out, offset, length, position) => {
      const n = Math.min(2, length, bytes.length - position);
      bytes.copy(out, offset, position, position + n);
      return { bytesRead: n };
    };
  expect((await Array.fromAsync(fileChunks({ read }, 12, 5))).map((b) => b.toString())).toEqual([
    "abcde",
    "fghij",
    "kl",
  ]);
  await expect(
    Array.fromAsync(fileChunks({ read: async () => ({ bytesRead: 0 }) }, 1)),
  ).rejects.toThrow("backup_file_changed");
});
it("round-trips a SQL export larger than one object with a short final part", async () => {
  artifact = await fixtureGeneration(join(directory, "large"), 8);
  const receipt = await publish();
  expect(receipt.parts).toBe(2);
  const publication = JSON.parse(objects.get(receipt.key));
  expect(publication.parts[0].bytes).toBe(CHUNK_BYTES);
  expect(publication.parts[1].bytes).toBeGreaterThan(0);
  const result = await download({ expectedSha256: receipt.sha256 });
  const source = await open(join(artifact.directory, "data.sql"), "r"),
    target = await open(join(result.directory, "data.sql"), "r");
  try {
    expect((await source.stat()).size).toBe((await target.stat()).size);
  } finally {
    await source.close();
    await target.close();
  }
}, 60000);
