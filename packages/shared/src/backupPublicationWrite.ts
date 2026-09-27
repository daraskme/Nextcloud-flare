import {
  BACKUP_CHUNK_BYTES,
  BACKUP_MANIFEST_BYTES,
  BACKUP_MAX_PARTS,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "./backupPublication.ts";

export interface BackupPublicationWrite {
  attemptId: string;
  generation: BackupGeneration;
  key: string;
  bytes: number;
  sha256: string;
}
export interface BackupPublicationWriteGrant {
  attemptId: string;
  id: string;
  epoch: number;
  token: string;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

/** The private exporter may write only one bounded object of its exact frozen generation. */
export function validateBackupPublicationWrite(request: BackupPublicationWrite): void {
  const generation = request?.generation;
  if (
    !request ||
    Object.keys(request).sort().join(",") !== "attemptId,bytes,generation,key,sha256" ||
    !uuid(request.attemptId) ||
    !generation ||
    Object.keys(generation).sort().join(",") !== "createdAt,epoch,id,token,watermark" ||
    !uuid(generation.id) ||
    !uuid(generation.token) ||
    !integer(generation.epoch, 1) ||
    !integer(generation.createdAt, 0) ||
    (generation.watermark !== null &&
      (typeof generation.watermark !== "string" ||
        generation.watermark.length < 1 ||
        generation.watermark.length > 128)) ||
    typeof request.key !== "string" ||
    !integer(request.bytes, 1) ||
    typeof request.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.sha256)
  )
    throw new Error("backup_invalid_publication_write");
  if (request.key === backupManifestKey(generation.id)) {
    if (request.bytes > BACKUP_MANIFEST_BYTES) throw new Error("backup_invalid_publication_write");
    return;
  }
  const part = /\/parts\/(\d{6})-([a-f0-9]{64})\.bin$/.exec(request.key);
  if (
    !part ||
    Number(part[1]) >= BACKUP_MAX_PARTS ||
    request.bytes > BACKUP_CHUNK_BYTES ||
    part[2] !== request.sha256 ||
    request.key !== backupPartKey(generation.id, Number(part[1]), request.sha256)
  )
    throw new Error("backup_invalid_publication_write");
}

export function validateBackupPublicationWriteGrant(grant: BackupPublicationWriteGrant): void {
  if (
    !grant ||
    Object.keys(grant).sort().join(",") !== "attemptId,epoch,id,token" ||
    !uuid(grant.attemptId) ||
    !uuid(grant.id) ||
    !uuid(grant.token) ||
    !integer(grant.epoch, 1)
  )
    throw new Error("backup_invalid_publication_write");
}
