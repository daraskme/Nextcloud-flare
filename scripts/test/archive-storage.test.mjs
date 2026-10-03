import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  archiveMembers,
  checkMountRecord,
  publishCiphertext,
  verifyMountedStorage,
} from "../../ops/backup/archive-storage.mjs";

let root;
const id = "12345678-1234-1234-1234-123456789012";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ncf-archive-storage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const mount = (target, uuid = "ABC123", options = "rw,nodev") => ({
  filesystems: [{ target, uuid, options }],
});

it("requires the exact mounted volume and write mode instead of the parent filesystem", () => {
  expect(() => checkMountRecord(mount(root), root, "abc123")).not.toThrow();
  for (const wrong of [
    mount("/"),
    mount(root, "OTHER"),
    mount(root, "ABC123", "ro,nodev"),
    mount(root, "ABC123", "rw,ro"),
    { filesystems: [] },
  ])
    expect(() => checkMountRecord(wrong, root, "ABC123")).toThrow();
});

it.skipIf(process.platform === "win32")(
  "probes the real output directory and never creates a missing mount",
  async () => {
    const output = join(root, "archives");
    await mkdir(output, { mode: 0o700 });
    const config = { mountPoint: root, volumeUuid: "ABC123", backupRoot: output };
    const command = async () => ({ stdout: JSON.stringify(mount(root)) });
    await verifyMountedStorage(config, { command });
    expect(await readdir(output)).toEqual([]);
    await expect(
      verifyMountedStorage({ ...config, backupRoot: join(root, "missing") }, { command }),
    ).rejects.toThrow("backup_volume_unavailable");
    expect(await readdir(root)).toEqual(["archives"]);
    await symlink(output, join(root, "alias"));
    await expect(
      verifyMountedStorage({ ...config, backupRoot: join(root, "alias") }, { command }),
    ).rejects.toThrow("backup_volume_unavailable");
  },
);

it.skipIf(process.platform === "win32")(
  "publishes only exact ciphertext, resumes identical copies, and preserves collisions",
  async () => {
    const source = join(root, "source.ncf"),
      target = join(root, "archive.ncf");
    const bytes = Buffer.concat([Buffer.from("NCFENC1\0"), Buffer.alloc(64, 3)]);
    await writeFile(source, bytes, { mode: 0o600 });
    const expected = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(await publishCiphertext(source, target, expected)).toEqual({
      ...expected,
      verified: true,
    });
    expect(await readFile(target)).toEqual(bytes);
    expect(await publishCiphertext(source, target, expected)).toEqual({
      ...expected,
      verified: true,
    });
    const collision = Buffer.concat([Buffer.from("NCFENC1\0"), Buffer.alloc(64, 7)]);
    await writeFile(target, collision);
    await expect(publishCiphertext(source, target, expected)).rejects.toThrow(
      "backup_archive_collision",
    );
    expect(await readFile(target)).toEqual(collision);
    await writeFile(source, "plaintext must never publish");
    await expect(publishCiphertext(source, target, expected)).rejects.toThrow(
      "backup_archive_not_ciphertext",
    );
    expect((await readdir(root)).some((name) => name.startsWith(".ncf-part-"))).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "archives only private allowlisted snapshot members, rejecting keys and symlinks",
  async () => {
    for (const directory of ["downloaded", `downloaded/${id}`, "blob-copy", "blob-copy/objects"])
      await mkdir(join(root, directory), { mode: 0o700 });
    const files = [
      `downloaded/${id}/manifest.json`,
      `downloaded/${id}/data.sql`,
      "blob-copy/manifest.json",
      "blob-copy/objects/00000000.bin",
    ];
    for (const file of files) await writeFile(join(root, file), "fixture", { mode: 0o600 });
    expect(await archiveMembers(root, id)).toEqual(files.sort());
    const extra = join(root, "blob-copy", "recovery.json");
    await writeFile(extra, "secret placeholder", { mode: 0o600 });
    await expect(archiveMembers(root, id)).rejects.toThrow("backup_archive_unsafe_member");
    await rm(extra);
    await chmod(join(root, files[0]), 0o644);
    await expect(archiveMembers(root, id)).rejects.toThrow("backup_archive_unsafe_member");
    await chmod(join(root, files[0]), 0o600);
    await symlink(join(root, files[0]), extra);
    await expect(archiveMembers(root, id)).rejects.toThrow("backup_archive_unsafe_member");
  },
);
