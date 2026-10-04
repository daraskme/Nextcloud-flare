export const TAR_BLOCK = 512;
export const MAX_TAR_BYTES = 536_870_912_000;
export const MAX_OBJECTS = 100_000;
export const MAX_USTAR_BYTES = 8 * 1024 ** 3 - 1;
export const PAX_SIZE_HEADER = "PaxHeaders/size";

const invalid = () => {
  throw new Error("backup_restore_tar_invalid");
};

export function archiveMemberAllowed(path, id) {
  return (
    path === `downloaded/${id}/manifest.json` ||
    path === `downloaded/${id}/data.sql` ||
    path === "blob-copy/manifest.json" ||
    /^blob-copy\/objects\/[0-9]{8}\.bin$/.test(path)
  );
}

export function archiveTarArguments(workDirectory, output, members) {
  return [
    "--create",
    "--format=pax",
    "--pax-option=delete=atime,delete=ctime,exthdr.name=PaxHeaders/size",
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--hard-dereference",
    "--file",
    output,
    "--directory",
    workDirectory,
    "--",
    ...members,
  ];
}

export function archiveTarBytes(sizes) {
  let bytes = 2 * TAR_BLOCK;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_BYTES)
      throw new Error("backup_archive_member_limit");
    bytes += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (size > MAX_USTAR_BYTES) bytes += 2 * TAR_BLOCK;
    if (bytes > MAX_TAR_BYTES) throw new Error("backup_archive_total_limit");
  }
  const blocked = Math.ceil(bytes / 10_240) * 10_240;
  if (blocked > MAX_TAR_BYTES) throw new Error("backup_archive_total_limit");
  return blocked;
}

function tarText(bytes) {
  const zero = bytes.indexOf(0);
  const data = zero < 0 ? bytes : bytes.subarray(0, zero);
  if (data.some((byte) => byte < 0x20 || byte > 0x7e)) invalid();
  return Buffer.from(data).toString("ascii");
}

function tarOctal(bytes) {
  const text = tarText(bytes).trim();
  if (!/^[0-7]{1,16}$/.test(text)) invalid();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

/** Only a single canonical size record; no path/link/uid/global overrides. */
export function parseArchivePaxSize(bytes) {
  if (bytes.length > 64 || bytes.some((byte) => byte > 0x7f)) invalid();
  const match = /^([1-9][0-9]*) size=([1-9][0-9]*)\n$/.exec(bytes.toString("ascii"));
  const size = Number(match?.[2]);
  if (
    !match ||
    String(bytes.length) !== match[1] ||
    !Number.isSafeInteger(size) ||
    size <= MAX_USTAR_BYTES ||
    size > MAX_TAR_BYTES
  )
    invalid();
  return size;
}

export function parseArchiveTarHeader(header, id, paxSize = null) {
  if (header.length !== TAR_BLOCK) invalid();
  const checksum = tarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK; index++)
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  const name = tarText(header.subarray(0, 100));
  const bytes = tarOctal(header.subarray(124, 136));
  const type = header[156];
  if (
    actual !== checksum ||
    tarText(header.subarray(257, 263)) !== "ustar" ||
    tarText(header.subarray(345, 500)) ||
    tarText(header.subarray(157, 257))
  )
    invalid();
  if (type === 0x78) {
    if (paxSize !== null || name !== PAX_SIZE_HEADER || bytes < 1 || bytes > 64) invalid();
    return { name, bytes, extended: true };
  }
  if (
    (type !== 0 && type !== 0x30) ||
    !archiveMemberAllowed(name, id) ||
    (paxSize !== null &&
      (!Number.isSafeInteger(paxSize) ||
        paxSize <= MAX_USTAR_BYTES ||
        paxSize > MAX_TAR_BYTES ||
        bytes !== 0))
  )
    invalid();
  return { name, bytes: paxSize ?? bytes, extended: false };
}
