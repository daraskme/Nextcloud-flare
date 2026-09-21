import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";
import { immutableBlobKey, transferImmutableBlob } from "../blobs.js";
import { loadUpload, uploadInfo, uploadStub } from "./common.js";

interface DurableStatus {
  metadata: {
    multipartUploadId?: string;
    state: string;
  } | null;
  parts: { partNumber: number; attempt: number; size: number; etag: string }[];
}

async function status(env: Env, uploadId: string): Promise<DurableStatus> {
  const response = await uploadStub(env, uploadId).fetch("https://upload.internal/status");
  if (!response.ok) throw new Error("upload_state_unavailable");
  return response.json();
}

async function beginReceiving(env: Env, user: AuthenticatedUser, uploadId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET state='receiving',updated_at=?1 WHERE id=?2 AND owner_id=?3 AND credential_id=?4 AND state='created' AND expires_at>?1 AND epoch=(SELECT epoch FROM control WHERE singleton=1) AND EXISTS(SELECT 1 FROM sessions WHERE id=?5 AND revoked_at IS NULL AND expires_at>?1)",
    ).bind(
      Date.now(),
      uploadId,
      user.principal.userId,
      user.principal.credentialId,
      user.principal.sessionId,
    ),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM uploads WHERE id=?1 AND owner_id=?2 AND credential_id=?3 AND state='receiving')",
    ).bind(uploadId, user.principal.userId, user.principal.credentialId),
  ]);
}

export async function putSingleContent(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
  source: ReadableStream<Uint8Array>,
  contentLength: number,
) {
  const upload = await loadUpload(env, user, uploadId, capability);
  if (upload.mode !== "single" || upload.state !== "created")
    throw new Error("single_put_forbidden");
  if (contentLength !== upload.declaredSize) throw new Error("upload_size_mismatch");
  await beginReceiving(env, user, upload.id);
  const started = await uploadStub(env, upload.id).fetch("https://upload.internal/single/start", {
    method: "POST",
  });
  if (!started.ok) throw new Error("single_put_forbidden");
  const blob = await transferImmutableBlob(env, {
    ownerId: upload.ownerId,
    blobId: upload.blobId,
    source,
    size: contentLength,
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET uploaded_size=?1,r2_etag=?2,updated_at=?3 WHERE id=?4 AND state='receiving' AND uploaded_size=0",
    ).bind(contentLength, blob.r2Etag, Date.now(), upload.id),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return uploadInfo(env, {
    ...upload,
    state: "receiving",
    uploadedSize: contentLength,
    r2Etag: blob.r2Etag,
  });
}

function validatePart(
  upload: Awaited<ReturnType<typeof loadUpload>>,
  partNumber: number,
  size: number,
): void {
  const expectedParts = Math.ceil(upload.declaredSize / upload.partSize);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > expectedParts) {
    throw new RangeError("Part number is invalid");
  }
  const expected =
    partNumber === expectedParts
      ? upload.declaredSize - upload.partSize * (expectedParts - 1)
      : upload.partSize;
  if (size !== expected || (partNumber < expectedParts && size < 5 * 1024 * 1024)) {
    throw new Error("upload_size_mismatch");
  }
}

async function abortUnknownMultipart(
  env: Env,
  upload: Awaited<ReturnType<typeof loadUpload>>,
  multipartUploadId: string,
): Promise<void> {
  const multipart = env.BLOBS.resumeMultipartUpload(
    immutableBlobKey(upload.ownerId, upload.blobId),
    multipartUploadId,
  );
  await multipart.abort();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET state='aborted',failure_reason='part_result_unknown',updated_at=?1 WHERE id=?2 AND state='receiving'",
    ).bind(Date.now(), upload.id),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-?1 WHERE id=?2 AND reserved_bytes>=?1",
    ).bind(upload.reservedBytes, upload.ownerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  await uploadStub(env, upload.id).fetch("https://upload.internal/aborted", { method: "POST" });
}

export async function putMultipartPart(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
  partNumber: number,
  source: ReadableStream<Uint8Array>,
  contentLength: number,
) {
  const upload = await loadUpload(env, user, uploadId, capability);
  if (upload.mode !== "multipart" || !["created", "receiving"].includes(upload.state)) {
    throw new Error("multipart_part_forbidden");
  }
  validatePart(upload, partNumber, contentLength);
  await beginReceiving(env, user, upload.id);
  const durable = await status(env, upload.id);
  const multipartUploadId = durable.metadata?.multipartUploadId;
  if (multipartUploadId === undefined) throw new Error("multipart_state_missing");
  const claimResponse = await uploadStub(env, upload.id).fetch(
    `https://upload.internal/parts/${partNumber}/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: contentLength }),
    },
  );
  if (!claimResponse.ok) throw new Error("part_attempt_rejected");
  const claim: { attempt: number } = await claimResponse.json();
  const multipart = env.BLOBS.resumeMultipartUpload(
    immutableBlobKey(upload.ownerId, upload.blobId),
    multipartUploadId,
  );
  const fixed = new FixedLengthStream(contentLength);
  try {
    const [part] = await Promise.all([
      multipart.uploadPart(partNumber, fixed.readable),
      source.pipeTo(fixed.writable),
    ]);
    const stored = {
      partNumber,
      attempt: claim.attempt,
      size: contentLength,
      etag: part.etag,
    };
    const finished = await uploadStub(env, upload.id).fetch(
      `https://upload.internal/parts/${partNumber}/stored`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stored),
      },
    );
    if (!finished.ok) throw new Error("part_fence_rejected");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO upload_parts(upload_id,part_number,attempt,size,etag,state) VALUES(?1,?2,?3,?4,?5,'stored')",
      ).bind(upload.id, partNumber, claim.attempt, contentLength, part.etag),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      env.DB.prepare(
        "UPDATE uploads SET uploaded_size=uploaded_size+?1,updated_at=?2 WHERE id=?3 AND state='receiving' AND uploaded_size+?1<=declared_size",
      ).bind(contentLength, Date.now(), upload.id),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return stored;
  } catch (error) {
    await uploadStub(env, upload.id).fetch(`https://upload.internal/parts/${partNumber}/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber, attempt: claim.attempt, size: contentLength, etag: "" }),
    });
    await abortUnknownMultipart(env, upload, multipartUploadId);
    throw error;
  }
}
