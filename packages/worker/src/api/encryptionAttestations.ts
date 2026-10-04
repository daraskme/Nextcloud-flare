import {
  adminReceiptPayload,
  encryptionHeaderHash,
  legacyAdoptionPayload,
  verifyEncryptionAttestation,
} from "@next-cloud-flare/shared/encryptionAttestation";
import { problem } from "@next-cloud-flare/shared/errors";
import { parseLegacyContainerHeader } from "@next-cloud-flare/shared/signedContainer";
import type { CsrfTokens } from "../auth/csrf";
import {
  type AccessSession,
  assertLiveAccessCredential,
  readAccessSession,
} from "../auth/sessions";
import { assertExists, assertOneChange, primary } from "../db/primary";
import type { Env } from "../env";
import {
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
  userActor,
} from "../services/accountMutation";
import { blobEncryptionDto, readBlobEncryption } from "../services/encryptionMarker";

const ADOPT = /^\/api\/v1\/encryption\/nodes\/([A-Za-z0-9_-]{1,128})\/adopt$/;
const RECEIPT = /^\/api\/v1\/encryption\/blobs\/([A-Za-z0-9_-]{1,128})\/admin-receipt$/;
const HASH = /^[a-f0-9]{64}$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function deny(): never {
  throw new Error("invalid_encryption_attestation");
}

export function encryptionAttestationRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return request.method === "POST" && (ADOPT.test(path) || RECEIPT.test(path));
}

async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body) deny();
  const reader = request.body.getReader();
  const buffer = new Uint8Array(2048);
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.length > buffer.length) deny();
      buffer.set(next.value, length);
      length += next.value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== keys.sort().join("\0")
  )
    deny();
  return value as Record<string, unknown>;
}

interface RegisteredKey {
  accountId: string;
  rsaFingerprint: string;
  signingFingerprint: string;
  signingSpki: string;
}
const KEY = `SELECT k.account_id AS accountId,k.rsa_fingerprint AS rsaFingerprint,
  k.signing_fingerprint AS signingFingerprint,k.signing_spki AS signingSpki
  FROM encryption_keys k JOIN users u ON u.id=k.account_id
  WHERE k.revoked_at IS NULL AND u.disabled_at IS NULL`;

// A folder share must not silently become an encrypted-file distribution route on adoption.
const PRIVATE_ANCESTRY = `WITH RECURSIVE ancestry(id,parent_id,depth) AS (
  SELECT id,parent_id,0 FROM nodes WHERE id=? AND owner_id=? AND deleted_at IS NULL
  UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN ancestry a ON n.id=a.parent_id
    WHERE n.owner_id=? AND n.deleted_at IS NULL AND a.depth<128
) SELECT 1 WHERE EXISTS(SELECT 1 FROM ancestry WHERE parent_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM shares s JOIN ancestry a ON a.id=s.root_node_id
   WHERE s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>strftime('%s','now')*1000))`;

async function readLegacyHeader(env: Env, key: string, size: number, expectedEtag: string) {
  if (!Number.isSafeInteger(size) || size < 12) deny();
  const prefix = await env.BLOBS.get(key, {
    range: { offset: 0, length: 12 },
    onlyIf: { etagMatches: expectedEtag },
  });
  if (!prefix || !("body" in prefix) || prefix.size !== size || prefix.etag !== expectedEtag)
    deny();
  const first = new Uint8Array(await prefix.arrayBuffer());
  if (first.length !== 12 || [78, 67, 70, 69, 78, 67, 49, 0].some((byte, i) => first[i] !== byte))
    deny();
  const length = new DataView(first.buffer).getUint32(8, false);
  if (length < 1 || length > 16 * 1024 || length + 12 > size) deny();
  const object = await env.BLOBS.get(key, {
    range: { offset: 0, length: 12 + length },
    onlyIf: { etagMatches: prefix.etag },
  });
  if (!object || !("body" in object) || object.size !== size || object.etag !== prefix.etag) deny();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== 12 + length) deny();
  const header = parseLegacyContainerHeader(bytes);
  if (header.totalBytes !== size) deny();
  return { header, headerSha256: await encryptionHeaderHash(bytes) };
}

async function adopt(
  env: Env,
  session: AccessSession,
  nodeId: string,
  input: Record<string, unknown>,
) {
  const { blobId, revision, headerSha256, ownerSignature, requiredAdminFingerprint } = input;
  if (
    typeof blobId !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof headerSha256 !== "string" ||
    !HASH.test(headerSha256) ||
    typeof ownerSignature !== "string" ||
    typeof requiredAdminFingerprint !== "string"
  )
    deny();
  const node = await primary(env.DB)
    .prepare(`SELECT b.r2_key AS r2Key,b.size,bs.r2_etag AS r2Etag FROM nodes n
    JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id AND b.state='committed'
    JOIN blob_storage bs ON bs.blob_id=b.id AND bs.bytes=b.size AND bs.r2_etag=b.r2_etag AND bs.removed_at IS NULL
    WHERE n.id=? AND n.owner_id=? AND n.current_blob_id=? AND n.revision=? AND n.kind='file' AND n.deleted_at IS NULL`)
    .bind(nodeId, session.user_id, blobId, revision)
    .first<{ r2Key: string; size: number; r2Etag: string }>();
  if (!node) deny();
  const owner = await primary(env.DB)
    .prepare(KEY + " AND k.account_id=?")
    .bind(session.user_id)
    .first<RegisteredKey>();
  const admin = await primary(env.DB)
    .prepare(KEY + " AND u.role='app_admin' AND k.rsa_fingerprint=?")
    .bind(requiredAdminFingerprint)
    .first<RegisteredKey>();
  if (!owner || !admin) deny();
  const { header, headerSha256: actualHash } = await readLegacyHeader(
    env,
    node.r2Key,
    node.size,
    node.r2Etag,
  );
  if (
    actualHash !== headerSha256 ||
    ![owner.rsaFingerprint, admin.rsaFingerprint].every((fingerprint) =>
      header.envelope.recipients.some((recipient) => recipient.fingerprint === fingerprint),
    )
  )
    deny();
  const payload = legacyAdoptionPayload({
    ownerId: session.user_id,
    nodeId,
    blobId,
    revision,
    headerSha256,
    cryptoId: header.envelope.cryptoId,
    requiredAdminFingerprint,
  });
  if (!(await verifyEncryptionAttestation(owner.signingSpki, ownerSignature, payload))) deny();
  const existing = await readBlobEncryption(env.DB, blobId);
  if (existing) {
    if (
      existing.ownerId !== session.user_id ||
      existing.headerSha256 !== headerSha256 ||
      existing.ownerSignature !== ownerSignature
    )
      deny();
    return { encryption: blobEncryptionDto(existing) };
  }
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "encryption.file.adopt",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      `SELECT 1 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage bs ON bs.blob_id=b.id AND bs.bytes=b.size AND bs.r2_etag=b.r2_etag AND bs.removed_at IS NULL
      WHERE n.id=? AND n.owner_id=?
      AND n.current_blob_id=? AND n.revision=? AND n.deleted_at IS NULL AND b.state='committed'
      AND b.r2_key=? AND b.size=? AND bs.r2_etag=? AND (SELECT COUNT(*) FROM nodes WHERE current_blob_id=b.id)=1`,
      [nodeId, session.user_id, blobId, revision, node.r2Key, node.size, node.r2Etag],
    ),
    assertExists(PRIVATE_ANCESTRY, [nodeId, session.user_id, session.user_id]),
    assertExists(KEY + " AND k.account_id=? AND k.rsa_fingerprint=? AND k.signing_fingerprint=?", [
      session.user_id,
      owner.rsaFingerprint,
      owner.signingFingerprint,
    ]),
    assertExists(
      KEY +
        " AND k.account_id=? AND u.role='app_admin' AND k.rsa_fingerprint=? AND k.signing_fingerprint=?",
      [admin.accountId, admin.rsaFingerprint, admin.signingFingerprint],
    ),
    {
      sql: `INSERT INTO blob_encryption(blob_id,owner_id,header_sha256,signer_rsa_fingerprint,signer_signing_fingerprint,
        required_admin_fingerprint,crypto_id,format_version,owner_signature,attested_node_id,attested_revision,admin_receipt_state,verified_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,'pending',strftime('%s','now')*1000)`,
      values: [
        blobId,
        session.user_id,
        headerSha256,
        owner.rsaFingerprint,
        owner.signingFingerprint,
        requiredAdminFingerprint,
        header.envelope.cryptoId,
        ownerSignature,
        nodeId,
        revision,
      ],
    },
    assertOneChange,
  ]);
  return { encryption: blobEncryptionDto((await readBlobEncryption(env.DB, blobId))!) };
}

async function receipt(
  env: Env,
  session: AccessSession,
  blobId: string,
  input: Record<string, unknown>,
) {
  const { headerSha256, signature } = input;
  if (typeof headerSha256 !== "string" || !HASH.test(headerSha256) || typeof signature !== "string")
    deny();
  const marker = await readBlobEncryption(env.DB, blobId);
  const admin = await primary(env.DB)
    .prepare(KEY + " AND k.account_id=? AND u.role='app_admin'")
    .bind(session.user_id)
    .first<RegisteredKey>();
  if (
    !marker ||
    !admin ||
    marker.headerSha256 !== headerSha256 ||
    admin.rsaFingerprint !== marker.requiredAdminFingerprint
  )
    deny();
  const payload = adminReceiptPayload({
    ownerId: marker.ownerId,
    blobId,
    headerSha256,
    cryptoId: marker.cryptoId,
    adminAccountId: session.user_id,
    adminFingerprint: admin.rsaFingerprint,
  });
  if (!(await verifyEncryptionAttestation(admin.signingSpki, signature, payload))) deny();
  const admission = await acquireAccountMutation(
    env,
    marker.ownerId,
    session.epoch,
    "encryption.admin.receipt",
    userActor(session.user_id),
  );
  await commitAccountMutation(env.DB, admission, marker.ownerId, [
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      KEY +
        " AND k.account_id=? AND u.role='app_admin' AND k.rsa_fingerprint=? AND k.signing_fingerprint=?",
      [session.user_id, admin.rsaFingerprint, admin.signingFingerprint],
    ),
    assertExists(KEY + " AND k.account_id=? AND k.rsa_fingerprint=? AND k.signing_fingerprint=?", [
      marker.ownerId,
      marker.signerRsaFingerprint,
      marker.signerSigningFingerprint,
    ]),
    assertExists(
      "SELECT 1 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE b.id=? AND n.owner_id=? AND n.deleted_at IS NULL AND b.state='committed'",
      [blobId, marker.ownerId],
    ),
    {
      sql: `UPDATE blob_encryption SET admin_receipt_state='verified',admin_receipt_signature=?,
      admin_account_id=?,admin_verified_at=strftime('%s','now')*1000
      WHERE blob_id=? AND owner_id=? AND header_sha256=? AND crypto_id=? AND required_admin_fingerprint=?`,
      values: [
        signature,
        session.user_id,
        blobId,
        marker.ownerId,
        headerSha256,
        marker.cryptoId,
        admin.rsaFingerprint,
      ],
    },
    assertOneChange,
  ]);
  return { encryption: blobEncryptionDto((await readBlobEncryption(env.DB, blobId))!) };
}

export async function handleEncryptionAttestationHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    !encryptionAttestationRoute(request)
  )
    return problem(404, "not_found");
  const live = await readAccessSession(env.DB, session.credential_id, session.epoch);
  if (live?.user_id !== session.user_id || request.headers.get("Origin") !== env.APP_ORIGIN)
    return problem(403, "forbidden");
  const nodeId = ADOPT.exec(url.pathname)?.[1];
  if (!nodeId && live.role !== "app_admin") return problem(403, "forbidden");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  try {
    const input = await body(
      request,
      nodeId
        ? ["blobId", "revision", "headerSha256", "ownerSignature", "requiredAdminFingerprint"]
        : ["headerSha256", "signature"],
    );
    const result = nodeId
      ? await adopt(env, session, nodeId, input)
      : await receipt(env, session, RECEIPT.exec(url.pathname)![1]!, input);
    return Response.json(result, { headers: HEADERS });
  } catch (error) {
    if (error instanceof MutationUnavailableError) return problem(503, "not_ready");
    if (
      error instanceof Error &&
      (error.message === "invalid_encryption_attestation" ||
        error.message === "invalid_signed_container" ||
        error instanceof SyntaxError ||
        error instanceof TypeError)
    )
      return problem(400, "bad_request");
    return problem(503, "not_ready");
  }
}
