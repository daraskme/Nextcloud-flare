import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { archiveMembers } from "../../ops/backup/archive-storage.mjs";
import {
  archiveTarArguments,
  archiveTarBytes,
  MAX_TAR_BYTES,
  MAX_USTAR_BYTES,
  PAX_SIZE_HEADER,
  parseArchivePaxSize,
  parseArchiveTarHeader,
} from "../backup/archiveFormat.mjs";
import { extractArchiveTar } from "../backup/restoreEncryptedArchive.mjs";

const id = "12345678-1234-1234-1234-123456789012";
const roots = [];
const posixIt = it.skipIf(process.platform === "win32");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function header(name, bytes = 0, type = "0") {
  const data = Buffer.alloc(512);
  data.write(name, 0, "ascii");
  data.write(bytes.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  data[156] = type.charCodeAt(0);
  data.write("ustar\0", 257, "ascii");
  data.fill(0x20, 148, 156);
  const checksum = data.reduce((sum, byte) => sum + byte, 0);
  data.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return data;
}
function paxRecord(key, value) {
  const payload = ` ${key}=${value}\n`;
  let length = payload.length + 1;
  while (String(length).length + payload.length !== length)
    length = String(length).length + payload.length;
  return Buffer.from(String(length) + payload);
}
function extended(payload, name = PAX_SIZE_HEADER, type = "x") {
  const padded = Buffer.alloc(Math.ceil(payload.length / 512) * 512);
  payload.copy(padded);
  return Buffer.concat([header(name, payload.length, type), padded]);
}
async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), "ncf-tar-format-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

posixIt(
  "real GNU pax writer and the reader agree at the exact 8GiB boundary without writing the member payload",
  async () => {
    const root = await rootFixture();
    for (const name of ["downloaded", `downloaded/${id}`, "blob-copy", "blob-copy/objects"])
      await mkdir(join(root, name), { mode: 0o700 });
    for (const name of [
      `downloaded/${id}/manifest.json`,
      `downloaded/${id}/data.sql`,
      "blob-copy/manifest.json",
    ])
      await writeFile(join(root, name), "fixture", { mode: 0o600 });
    const path = "blob-copy/objects/00000000.bin";
    const file = await open(join(root, path), "wx", 0o600);
    try {
      for (const bytes of [MAX_USTAR_BYTES, MAX_USTAR_BYTES + 1, MAX_TAR_BYTES]) {
        await file.truncate(bytes);
        expect((await lstat(join(root, path))).blocks).toBe(0);
        if (bytes === MAX_TAR_BYTES)
          await expect(archiveMembers(root, id)).rejects.toThrow("backup_archive_total_limit");
        else expect(await archiveMembers(root, id)).toContain(path);
        const child = spawn("tar", archiveTarArguments(root, "-", [path]), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const closed = once(child, "close");
        let prefix = Buffer.alloc(0);
        try {
          for await (const chunk of child.stdout) {
            prefix = Buffer.concat([prefix, chunk]).subarray(0, 1536);
            if (prefix.length >= 1536) break;
          }
        } finally {
          child.kill("SIGKILL");
          await closed;
        }
        const first = parseArchiveTarHeader(prefix.subarray(0, 512), id);
        if (bytes <= MAX_USTAR_BYTES) expect(first).toEqual({ name: path, bytes, extended: false });
        else {
          expect(first.extended).toBe(true);
          const size = parseArchivePaxSize(prefix.subarray(512, 512 + first.bytes));
          expect(size).toBe(bytes);
          expect(parseArchiveTarHeader(prefix.subarray(1024, 1536), id, size)).toEqual({
            name: path,
            bytes,
            extended: false,
          });
        }
      }
    } finally {
      await file.close();
    }
  },
);

it("accepts only canonical, bounded, single size records and refuses malicious extended-header overrides", () => {
  expect(archiveTarBytes([8 * 1024 ** 3])).toBe(8 * 1024 ** 3 + 12_288);
  expect(() => archiveTarBytes([MAX_TAR_BYTES])).toThrow("backup_archive_total_limit");
  expect(() => archiveTarBytes([MAX_TAR_BYTES / 2, MAX_TAR_BYTES / 2])).toThrow(
    "backup_archive_total_limit",
  );
  expect(() => archiveTarBytes([MAX_TAR_BYTES + 1])).toThrow("backup_archive_member_limit");
  expect(parseArchivePaxSize(paxRecord("size", 8 * 1024 ** 3))).toBe(8 * 1024 ** 3);
  for (const payload of [
    paxRecord("path", "../../escape"),
    paxRecord("linkpath", "../escape"),
    paxRecord("size", MAX_TAR_BYTES + 1),
    paxRecord("size", MAX_USTAR_BYTES),
    paxRecord("size", "08589934592"),
    paxRecord("size", "-1"),
    paxRecord("size", "1e10"),
    Buffer.concat([paxRecord("size", 8 * 1024 ** 3), paxRecord("size", 8 * 1024 ** 3)]),
    Buffer.from("18 size=8589934592\n"),
    Buffer.from("19 size=8589934592\nextra"),
  ])
    expect(() => parseArchivePaxSize(payload)).toThrow("backup_restore_tar_invalid");
  for (const data of [
    header("../escape"),
    header(PAX_SIZE_HEADER, 19, "g"),
    header("blob-copy/objects/00000000.bin", 0, "2"),
    header(PAX_SIZE_HEADER, 65, "x"),
  ])
    expect(() => parseArchiveTarHeader(data, id)).toThrow("backup_restore_tar_invalid");
  expect(() =>
    parseArchiveTarHeader(header("blob-copy/objects/00000000.bin", 1), id, 8 * 1024 ** 3),
  ).toThrow();
});

posixIt(
  "writer emits regular allowlisted members even for shared inodes and respects its preflight bound",
  async () => {
    const root = await rootFixture();
    const work = join(root, "work");
    await mkdir(work, { mode: 0o700 });
    for (const name of ["downloaded", `downloaded/${id}`, "blob-copy", "blob-copy/objects"])
      await mkdir(join(work, name), { mode: 0o700 });
    for (const name of [
      `downloaded/${id}/manifest.json`,
      `downloaded/${id}/data.sql`,
      "blob-copy/manifest.json",
    ])
      await writeFile(join(work, name), "fixture", { mode: 0o600 });
    await link(
      join(work, `downloaded/${id}/data.sql`),
      join(work, "blob-copy/objects/00000000.bin"),
    );
    const members = await archiveMembers(work, id);
    const tar = join(root, "regular.tar");
    await promisify(execFile)("tar", archiveTarArguments(work, tar, members));
    expect((await lstat(tar)).size).toBe(archiveTarBytes(members.map(() => 7)));
    const destination = join(root, "regular");
    expect(await extractArchiveTar(tar, destination, id)).toEqual(new Set(members));
    expect(await readFile(join(destination, "blob-copy/objects/00000000.bin"), "utf8")).toBe(
      "fixture",
    );
  },
);

posixIt(
  "extractor rejects traversal, repeated/global/dangling extensions, duplicates and truncated large bodies without publishing a tree",
  async () => {
    const root = await rootFixture();
    const size = paxRecord("size", 8 * 1024 ** 3);
    const end = Buffer.alloc(1024);
    const allowed = `downloaded/${id}/manifest.json`;
    const cases = [
      Buffer.concat([extended(paxRecord("path", "../escape")), header(allowed), end]),
      Buffer.concat([extended(size), extended(size), header(allowed), end]),
      Buffer.concat([extended(size, PAX_SIZE_HEADER, "g"), header(allowed), end]),
      Buffer.concat([extended(size), end]),
      Buffer.concat([extended(size), header("../escape"), end]),
      Buffer.concat([extended(size), header(allowed, 1), end]),
      Buffer.concat([header(allowed), header(allowed), end]),
      Buffer.concat([extended(size), header(allowed), end]),
    ];
    for (const [index, data] of cases.entries()) {
      const tar = join(root, `case-${index}.tar`),
        destination = join(root, `case-${index}`);
      await writeFile(tar, data, { mode: 0o600 });
      await expect(extractArchiveTar(tar, destination, id)).rejects.toThrow(
        /backup_restore_tar_(invalid|truncated)/,
      );
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    const oversized = join(root, "oversized.tar");
    const file = await open(oversized, "wx", 0o600);
    await file.truncate(MAX_TAR_BYTES + 512);
    await file.close();
    await expect(extractArchiveTar(oversized, join(root, "oversized"), id)).rejects.toThrow(
      "backup_restore_tar_invalid",
    );
  },
);
