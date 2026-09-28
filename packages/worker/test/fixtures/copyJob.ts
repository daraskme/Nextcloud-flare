import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { createCopyJob } from "../../src/services/createCopyJob";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { foundationFixture } from "./foundation";
import { mutationEnv } from "./mutationAdmission";
import { admitted } from "./uploadEnv";

export async function copyJobFixture(empty = false) {
  const source = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const target = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...source.statements.map((s) =>
      empty && s.sql.startsWith("INSERT INTO blobs")
        ? { ...s, sql: s.sql.replace(",3,?,'committed'", ",0,?,'committed'") }
        : s,
    ),
    ...target.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [target.ids.user + "@example.invalid", target.ids.user],
    },
  ]);
  const key = `u/${source.ids.user}/b/${source.ids.blob}`;
  const stored = await env.BLOBS.put(key, empty ? "" : "abc");
  if (!stored) throw new Error("fixture_r2_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,1)",
  )
    .bind(source.ids.blob, empty ? 0 : 3, stored.etag)
    .run();
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=? WHERE bootstrap_done_at IS NULL",
  )
    .bind(source.ids.user)
    .run();
  const session = {
    user_id: source.ids.user,
    credential_id: source.ids.credential,
    session_id: source.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const share = await createInternalShare(mutationEnv(), session, {
    kind: "internal",
    rootNodeId: source.ids.folder,
    recipients: [target.ids.user + "@example.invalid"],
    role: "read",
    expiresAt: null,
  });
  const request = {
    principal: {
      kind: "user" as const,
      user_id: target.ids.user,
      credential_id: target.ids.credential,
      epoch: 1,
      selected_share: share,
    },
    sourceSpaceId: source.ids.space,
    sourceNodeId: source.ids.folder,
    destination: { spaceId: target.ids.space, share: null },
    destinationParentId: target.ids.folder,
    name: "Copy",
    depth: "infinity" as const,
    requestId: crypto.randomUUID(),
    lockTokens: [],
  };
  const enqueue = async () => {
    const result = await createCopyJob(admitted(), { ...request, requestId: crypto.randomUUID() });
    if (result.kind !== "terminal" || !result.operation.result?.jobId)
      throw new Error("fixture_copy_failed");
    const outboxId = result.operation.id + "_copy";
    expect(
      await dispatchOutbox(
        mutationEnv(),
        { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }) },
        outboxId,
        1,
      ),
    ).toBe("sent");
    return { id: result.operation.result.jobId, outboxId };
  };
  const job = await enqueue();
  return {
    source,
    target,
    key,
    stored,
    share,
    session,
    request,
    job,
    enqueue,
    revoke: () => updateInternalShare(mutationEnv(), session, share.id, share.version, null),
    range: { blobId: source.ids.blob, offset: 0, length: empty ? 0 : 3 },
  };
}
export function copyReaderEnv(get = vi.fn(env.BLOBS.get.bind(env.BLOBS)), db = env.DB) {
  return { ...mutationEnv(db), BLOBS: { get } as unknown as R2Bucket };
}
export async function copyJobCounters(id: string) {
  return env.DB.prepare(
    "SELECT j.state,j.invocation_count,j.r2_calls,l.attempt,l.r2_calls AS lease_calls FROM bulk_jobs j LEFT JOIN job_leases l ON l.job_id=j.id WHERE j.id=?",
  )
    .bind(id)
    .first();
}
