import { scopes } from "@ncf/shared";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import { reconcileExpiredUploads } from "../../src/jobs/uploads.js";
import { immutableBlobKey } from "../../src/services/blobs.js";
import { abortUpload } from "../../src/services/uploads/abort.js";
import { completeUpload, getUploadStatus } from "../../src/services/uploads/complete.js";
import { createUpload } from "../../src/services/uploads/create.js";
import { putMultipartPart, putSingleContent } from "../../src/services/uploads/transfer.js";
import { uploadStub } from "../../src/services/uploads/common.js";
import { seedFoundation } from "../helpers/foundation.js";

const user: AuthenticatedUser = {
  email: "user@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "user",
    userId: "user",
    sessionId: "session",
    credentialId: "as:session",
    scopes: [...scopes],
  },
};

function bytes(size: number, fill = 97): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (size > 0) controller.enqueue(new Uint8Array(size).fill(fill));
      controller.close();
    },
  });
}

function capability(upload: { capability?: string }): string {
  if (upload.capability === undefined) throw new Error("capability missing");
  return upload.capability;
}

beforeEach(async () => {
  await seedFoundation();
  await env.DB.prepare("UPDATE users SET quota_bytes=50000000 WHERE id='user'").run();
});

describe("upload state machine", () => {
  it("completes a zero-byte single upload and rejects re-PUT/terminal abort", async () => {
    const upload = await createUpload(env, user, {
      parentId: "root",
      name: "empty.txt",
      declaredSize: 0,
      mode: "single",
    });
    await putSingleContent(env, user, upload.id, capability(upload), bytes(0), 0);
    await expect(
      putSingleContent(env, user, upload.id, capability(upload), bytes(0), 0),
    ).rejects.toThrow("single_put_forbidden");
    const node = await completeUpload(env, user, upload.id, capability(upload));
    expect(node).toMatchObject({ name: "empty.txt", kind: "file", size: 0 });
    await expect(abortUpload(env, user, upload.id, capability(upload))).rejects.toThrow(
      "completed_abort_forbidden",
    );
    const ledger = await env.DB.prepare(
      "SELECT u.state,b.state blob_state,b.ref_count,usr.used_bytes,usr.reserved_bytes FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN users usr ON usr.id=u.owner_id WHERE u.id=?1",
    )
      .bind(upload.id)
      .first();
    expect(ledger).toEqual({
      state: "completed",
      blob_state: "committed",
      ref_count: 1,
      used_bytes: 0,
      reserved_bytes: 0,
    });
  });

  it("accepts normalized Japanese, spaced CBZ, and emoji upload names", async () => {
    const names = ["旅行メモ.txt", "同人誌 vol.1.cbz", "写真📷.jpg"];
    for (const name of names) {
      const upload = await createUpload(env, user, {
        parentId: "root",
        name,
        declaredSize: 0,
        mode: "single",
      });
      await putSingleContent(env, user, upload.id, capability(upload), bytes(0), 0);
      await expect(completeUpload(env, user, upload.id, capability(upload))).resolves.toMatchObject(
        {
          name,
        },
      );
    }
  });

  it("reports conflict metadata and resolves overwrite, auto-rename, and skip", async () => {
    const original = await createUpload(env, user, {
      parentId: "root",
      name: "same.txt",
      declaredSize: 0,
      mode: "single",
    });
    await putSingleContent(env, user, original.id, capability(original), bytes(0), 0);
    const existing = await completeUpload(env, user, original.id, capability(original));

    const overwrite = await createUpload(env, user, {
      parentId: "root",
      name: "same.txt",
      declaredSize: 4,
      mode: "single",
    });
    await putSingleContent(env, user, overwrite.id, capability(overwrite), bytes(4), 4);
    await expect(
      completeUpload(env, user, overwrite.id, capability(overwrite)),
    ).rejects.toMatchObject({
      message: "name_conflict",
      existingNodeId: existing.id,
      revision: existing.revision,
    });
    await expect(
      getUploadStatus(env, user, overwrite.id, capability(overwrite)),
    ).resolves.toMatchObject({
      state: "receiving",
    });
    const replaced = await completeUpload(env, user, overwrite.id, capability(overwrite), {
      conflictMode: "overwrite",
      expectedRevision: existing.revision,
    });
    expect(replaced).toMatchObject({ id: existing.id, revision: existing.revision + 1, size: 4 });

    const renamed = await createUpload(env, user, {
      parentId: "root",
      name: "same.txt",
      declaredSize: 0,
      mode: "single",
    });
    await putSingleContent(env, user, renamed.id, capability(renamed), bytes(0), 0);
    await expect(
      completeUpload(env, user, renamed.id, capability(renamed), { conflictMode: "rename" }),
    ).resolves.toMatchObject({ name: "same (1).txt" });

    const skipped = await createUpload(env, user, {
      parentId: "root",
      name: "same.txt",
      declaredSize: 0,
      mode: "single",
    });
    await putSingleContent(env, user, skipped.id, capability(skipped), bytes(0), 0);
    await expect(completeUpload(env, user, skipped.id, capability(skipped))).rejects.toThrow(
      "name_conflict",
    );
    await abortUpload(env, user, skipped.id, capability(skipped));
    await expect(
      getUploadStatus(env, user, skipped.id, capability(skipped)),
    ).resolves.toMatchObject({
      state: "aborted",
    });
  });

  it("rejects a false single size without consuming the one allowed PUT", async () => {
    const upload = await createUpload(env, user, {
      parentId: "root",
      name: "four.bin",
      declaredSize: 4,
      mode: "single",
    });
    await expect(
      putSingleContent(env, user, upload.id, capability(upload), bytes(3), 3),
    ).rejects.toThrow("upload_size_mismatch");
    const current = await getUploadStatus(env, user, upload.id, capability(upload));
    expect(current.state).toBe("created");
    await putSingleContent(env, user, upload.id, capability(upload), bytes(4), 4);
  });

  it("resumes multipart status, rejects missing parts, and completes exact bytes", async () => {
    const partSize = 8 * 1024 * 1024;
    const upload = await createUpload(env, user, {
      parentId: "root",
      name: "large.bin",
      declaredSize: partSize + 1,
      mode: "multipart",
    });
    await putMultipartPart(env, user, upload.id, capability(upload), 1, bytes(partSize), partSize);
    const resumed = await getUploadStatus(env, user, upload.id, capability(upload));
    expect(resumed.parts).toHaveLength(1);
    expect(resumed.uploadedSize).toBe(partSize);
    await expect(completeUpload(env, user, upload.id, capability(upload))).rejects.toThrow(
      "parts_incomplete",
    );
    await putMultipartPart(env, user, upload.id, capability(upload), 2, bytes(1, 98), 1);
    const node = await completeUpload(env, user, upload.id, capability(upload));
    expect(node).toMatchObject({ name: "large.bin", size: partSize + 1 });
    const object = await env.BLOBS.head(immutableBlobKey("user", node.blobId ?? ""));
    expect(object?.size).toBe(partSize + 1);
  });

  it("fences three part attempts and moves unknown results to durable aborting", async () => {
    const id = `attempts-${crypto.randomUUID()}`;
    const stub = uploadStub(env, id);
    const size = 5 * 1024 * 1024;
    const initialized = await stub.fetch("https://upload.internal/initialize", {
      method: "POST",
      body: JSON.stringify({
        uploadId: id,
        mode: "multipart",
        declaredSize: size,
        partSize: size,
        multipartUploadId: "r2",
      }),
    });
    expect(initialized.status).toBe(201);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await stub.fetch("https://upload.internal/parts/1/claim", {
        method: "POST",
        body: JSON.stringify({ size }),
      });
      expect(claim.status).toBe(200);
      const stored = await stub.fetch("https://upload.internal/parts/1/stored", {
        method: "POST",
        body: JSON.stringify({ partNumber: 1, attempt, size, etag: `etag-${attempt}` }),
      });
      expect(stored.status).toBe(204);
    }
    const fourth = await stub.fetch("https://upload.internal/parts/1/claim", {
      method: "POST",
      body: JSON.stringify({ size }),
    });
    expect(fourth.status).toBe(409);

    const unknownId = `unknown-${crypto.randomUUID()}`;
    const unknown = uploadStub(env, unknownId);
    await unknown.fetch("https://upload.internal/initialize", {
      method: "POST",
      body: JSON.stringify({
        uploadId: unknownId,
        mode: "multipart",
        declaredSize: size,
        partSize: size,
        multipartUploadId: "r2",
      }),
    });
    await unknown.fetch("https://upload.internal/parts/1/claim", {
      method: "POST",
      body: JSON.stringify({ size }),
    });
    await unknown.fetch("https://upload.internal/parts/1/unknown", {
      method: "POST",
      body: JSON.stringify({ partNumber: 1, attempt: 1, size, etag: "" }),
    });
    const status: { metadata: { state: string; acceptParts: boolean } } = await (
      await unknown.fetch("https://upload.internal/status")
    ).json();
    expect(status.metadata).toMatchObject({ state: "aborting", acceptParts: false });
  });

  it("expires absent single uploads and accounts present unknown objects as orphans", async () => {
    const absent = await createUpload(env, user, {
      parentId: "root",
      name: "absent.bin",
      declaredSize: 4,
      mode: "single",
    });
    await env.DB.prepare("UPDATE uploads SET expires_at=0 WHERE id=?1").bind(absent.id).run();
    await reconcileExpiredUploads(env);
    const absentRow = await env.DB.prepare("SELECT state FROM uploads WHERE id=?1")
      .bind(absent.id)
      .first<{ state: string }>();
    expect(absentRow?.state).toBe("expired");

    const present = await createUpload(env, user, {
      parentId: "root",
      name: "present.bin",
      declaredSize: 4,
      mode: "single",
    });
    const row = await env.DB.prepare("SELECT blob_id FROM uploads WHERE id=?1")
      .bind(present.id)
      .first<{ blob_id: string }>();
    if (row === null) throw new Error("upload missing");
    await env.BLOBS.put(immutableBlobKey("user", row.blob_id), "data");
    await env.DB.prepare("UPDATE uploads SET state='receiving',expires_at=0 WHERE id=?1")
      .bind(present.id)
      .run();
    await reconcileExpiredUploads(env);
    const orphan = await env.DB.prepare(
      "SELECT u.state,b.state blob_state,usr.physical_bytes,usr.reserved_bytes FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN users usr ON usr.id=u.owner_id WHERE u.id=?1",
    )
      .bind(present.id)
      .first();
    expect(orphan).toEqual({
      state: "failed",
      blob_state: "orphan",
      physical_bytes: 4,
      reserved_bytes: 4,
    });
  });
});
