import {
  type ExtractedMediaKind,
  MEDIA_EXTRACTION_GENERATOR,
  type MediaExtractionReceipt,
} from "../../../shared/src/mediaExtraction";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { freezePrincipal } from "../auth/selectedShare";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { MEDIA_REQUEST_SOURCE, mediaRequestKey } from "../jobs/mediaRequestAuthority";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  operationIntent,
} from "../jobs/operations";
import { dispatchOutbox } from "../jobs/outbox";
import { commitMutationStatements } from "./fsMutation";

/** Enqueue only. Bounded original reads and derived metadata publication happen in the saved-reader job. */
export async function requestMediaExtraction(
  env: Pick<Env, "DB" | "CONTROL" | "LOCKS" | "JOBS">,
  principal: Principal,
  nodeId: string,
  blobId: string,
  requestKey: string,
): Promise<MediaExtractionReceipt> {
  principal = freezePrincipal(principal);
  if (
    !["user", "link_share"].includes(principal.kind) ||
    ![nodeId, blobId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("invalid_media_request");
  const spaceId = await primary(env.DB)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("authorization_denied");
  const proof = await authorizeNode(env.DB, principal, {
    operation: "gallery.read",
    nodeId,
    spaceId,
  });
  if (
    proof.operation !== "gallery.read" ||
    proof.node.kind !== "file" ||
    !proof.node.parent_id ||
    proof.node.current_blob_id !== blobId ||
    (principal.kind === "user" &&
      !principal.selected_share &&
      principal.user_id !== proof.node.owner_id)
  )
    throw new Error("authorization_denied");
  const n = proof.node,
    ownerId = n.owner_id,
    key = await mediaRequestKey(nodeId, blobId);
  const source = assertExists(MEDIA_REQUEST_SOURCE, [nodeId, n.parent_id!, blobId, ownerId]);
  const operands = {
    nodeId,
    parentId: n.parent_id!,
    blobId,
    generator: MEDIA_EXTRACTION_GENERATOR,
  };
  if (
    !(await primary(env.DB)
      .prepare(MEDIA_REQUEST_SOURCE)
      .bind(...source.values!)
      .first())
  )
    throw new Error("invalid_media_request");
  const intent = await operationIntent(
    principal,
    requestKey,
    spaceId,
    "media.extract",
    { nodeId, blobId },
    operands,
  );
  const existing = await findOperationIntent(env.DB, intent, 1);
  const read = async (): Promise<MediaExtractionReceipt | null> => {
    const records = await atomicBatch(env.DB, [
      authorizationAssertion(proof),
      source,
      {
        sql: "SELECT state,result_json FROM outbox WHERE outbox_id=? AND kind='media.requested' AND payload_ref=?",
        values: [key, key],
      },
    ]);
    const record = records.at(-1)?.results[0] as
      | { state: string; result_json: string | null }
      | undefined;
    if (!record) return null;
    let kind: ExtractedMediaKind | null = null;
    if (record.state === "completed") {
      const saved = JSON.parse(record.result_json ?? "null");
      if (
        !saved ||
        Object.keys(saved).join(",") !== "kind" ||
        !["audio", "video", "image", "unsupported"].includes(saved.kind)
      )
        throw new Error("media_request_unavailable");
      kind = saved.kind;
    }
    return {
      nodeId,
      blobId,
      generator: MEDIA_EXTRACTION_GENERATOR,
      kind,
      state:
        record.state === "completed"
          ? kind === "unsupported"
            ? "unsupported"
            : "ready"
          : record.state === "failed"
            ? "failed"
            : "pending",
    };
  };
  const prior = await read();
  if (prior) return prior;
  if (existing && existing.state !== "claimed") throw new Error("media_request_unavailable");
  const lock = env.LOCKS.get(env.LOCKS.idFromName(spaceId));
  const permit = await lock.acquireMediaExtraction({
    requestId: intent.id,
    spaceId,
    nodeId,
    blobId,
    principal,
  });
  let terminal = false;
  try {
    const fresh = await authorizeNode(env.DB, principal, {
      operation: "gallery.read",
      nodeId,
      spaceId,
    });
    const claimed = await claimOperation(env.DB, intent, permit, fresh, 1);
    if (claimed.kind === "terminal") terminal = true;
    else {
      const result = await commitMutationStatements(env.DB, claimed.claim, [
        assertOpenPermit(permit),
        assertOperationClaim(claimed.claim),
        authorizationAssertion(fresh),
        source,
        {
          sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
          VALUES(?,?,'media.requested',?,'pending',?,strftime('%s','now')*1000,strftime('%s','now')*1000)`,
          values: [key, intent.id, key, principal.epoch],
        },
        assertOneChange,
        {
          sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'media_request',?)",
          values: [intent.id, key],
        },
        assertOneChange,
        {
          sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,strftime('%s','now')*1000)
          WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
          values: [JSON.stringify({ status: 202, nodeId }), intent.id, intent.id],
        },
        assertOneChange,
      ]);
      terminal = result.kind === "terminal";
    }
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* Lease recovery retains the receipt. */
      }
  }
  const accepted = await read();
  if (!accepted) throw new Error("media_request_unavailable");
  // The short namespace permit is released before Queue dispatch, and never held for R2 reads.
  if (terminal && accepted.state === "pending")
    try {
      await dispatchOutbox(env, env.JOBS, key, principal.epoch);
    } catch {
      /* Cron retries the same durable ID. */
    }
  return accepted;
}
