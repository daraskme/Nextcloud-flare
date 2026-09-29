import type { LargeThumbnailReceipt } from "../../../shared/src/largeThumbnail";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { freezePrincipal } from "../auth/selectedShare";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { IMAGE_REQUEST_SOURCE, imageRequestKey } from "../jobs/imageRequestAuthority";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  operationIntent,
} from "../jobs/operations";
import { dispatchOutbox } from "../jobs/outbox";
import { IMAGE_METADATA_GENERATOR } from "../media/images/inspect";
import { IMAGE_TRANSFORM_GENERATOR } from "../media/images/transform";
import { commitMutationStatements } from "./fsMutation";

/** Enqueue only. Native generation, R2 storage and publication happen in the saved-reader job. */
export async function requestLargeThumbnail(
  env: Pick<Env, "DB" | "CONTROL" | "LOCKS" | "JOBS">,
  principal: Principal,
  nodeId: string,
  blobId: string,
  requestKey: string,
): Promise<LargeThumbnailReceipt> {
  principal = freezePrincipal(principal);
  if (
    !["user", "link_share"].includes(principal.kind) ||
    ![nodeId, blobId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("invalid_image_request");
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
    key = await imageRequestKey(blobId);
  const source = assertExists(IMAGE_REQUEST_SOURCE, [
    nodeId,
    n.parent_id!,
    blobId,
    ownerId,
    IMAGE_METADATA_GENERATOR,
  ]);
  const operands = {
    nodeId,
    parentId: n.parent_id!,
    blobId,
    variant: "lg",
    generator: IMAGE_TRANSFORM_GENERATOR,
  };
  const intent = await operationIntent(
    principal,
    requestKey,
    spaceId,
    "thumbnail.request",
    { nodeId, blobId, variant: "lg" },
    operands,
  );
  const existing = await findOperationIntent(env.DB, intent, 1);
  const read = async (): Promise<LargeThumbnailReceipt | null> => {
    const records = await atomicBatch(env.DB, [
      authorizationAssertion(proof),
      source,
      {
        sql: `SELECT CASE
        WHEN d.state='ready' AND x.state='published' AND c.retired_at IS NULL AND c.seal_token IS NULL AND c.settled_at IS NULL AND c.image_id IS NOT NULL THEN 'ready'
        WHEN d.state='failed' THEN CASE WHEN d.error_code GLOB 'image_unsupported_*' THEN 'unsupported' ELSE 'failed' END
        WHEN t.state='failed' THEN 'failed'
        WHEN e.state='failed' THEN 'failed'
        WHEN t.id IS NOT NULL OR e.outbox_id IS NOT NULL OR d.id IS NOT NULL THEN 'pending'
        ELSE NULL END AS state
        FROM (SELECT 1) LEFT JOIN derivative_results d ON d.blob_id=? AND d.kind='thumbnail' AND d.variant='lg' AND d.generator_version=?
        LEFT JOIN image_derivative_objects x ON x.result_id=d.id LEFT JOIN image_derivative_cleanup c ON c.image_id=x.id
        LEFT JOIN image_transform_attempts t ON t.blob_id=? AND t.variant='lg' AND t.generator_version=? AND t.state<>'not_started'
        LEFT JOIN outbox e ON e.outbox_id=? AND e.kind='image.requested' AND e.payload_ref=?`,
        values: [blobId, IMAGE_TRANSFORM_GENERATOR, blobId, IMAGE_TRANSFORM_GENERATOR, key, key],
      },
    ]);
    const state = (
      records.at(-1)?.results[0] as { state: LargeThumbnailReceipt["state"] | null } | undefined
    )?.state;
    return state
      ? { nodeId, blobId, variant: "lg", generator: IMAGE_TRANSFORM_GENERATOR, state }
      : null;
  };
  const prior = await read();
  if (prior) return prior;
  if (existing && existing.state !== "claimed") throw new Error("image_request_unavailable");
  const lock = env.LOCKS.get(env.LOCKS.idFromName(spaceId));
  const permit = await lock.acquireThumbnail({
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
          VALUES(?,?,'image.requested',?,'pending',?,strftime('%s','now')*1000,strftime('%s','now')*1000)`,
          values: [key, intent.id, key, principal.epoch],
        },
        assertOneChange,
        {
          sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'image_request',?)",
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
  if (!accepted) throw new Error("image_request_unavailable");
  // The short namespace permit is released before Queue dispatch, and never held for Images/R2.
  if (terminal && accepted.state === "pending")
    try {
      await dispatchOutbox(env, env.JOBS, key, principal.epoch);
    } catch {
      /* Cron retries the same durable ID. */
    }
  return accepted;
}
