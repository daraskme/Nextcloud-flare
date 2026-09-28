import type { Principal } from "../auth/authorize";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { readCopyJob } from "../jobs/copyLifecycle";
import { loadCopyJobManifest } from "../jobs/copyManifest";
import { lookupOperation } from "../jobs/operations";
import { createCopyJob } from "./createCopyJob";
import type { MutationOutcome } from "./fsMutation";

/** A new snapshot and fresh keys, never a restart of a stopped native attempt. */
export async function retryCopyJob(
  env: Pick<Env, "DB" | "LOCKS">,
  principal: Principal,
  id: string,
  requestId: string,
): Promise<MutationOutcome> {
  if (
    principal.kind !== "user" ||
    !(await primary(env.DB)
      .prepare(`SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
      WHERE j.id=? AND j.kind='node.copy' AND o.kind='copy.enqueue' AND o.principal_kind='user'
        AND o.principal_id=? AND o.credential_id=? AND j.credential_id=o.credential_id`)
      .bind(id, principal.user_id, principal.credential_id)
      .first())
  )
    throw new Error("authorization_denied");
  const successor = async (): Promise<MutationOutcome | null> => {
    const operationId = await primary(env.DB)
      .prepare(`SELECT op_id FROM operations
      WHERE kind='copy.enqueue' AND state='committed' AND json_extract(operands_json,'$.retryOf')=?`)
      .bind(id)
      .first<string>("op_id");
    if (!operationId) return null;
    // Reauthorize the successor even after publication has trashed an overwrite.
    const operation = await lookupOperation(env.DB, principal, operationId);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  };
  const existing = await successor();
  if (existing) return existing;
  const status = await readCopyJob(env.DB, principal, id);
  if (!["cancelled", "failed"].includes(status.state)) throw new Error("copy_retry_not_stopped");
  if (status.cleanupPending || status.heldBytes) throw new Error("copy_retry_cleanup_pending");
  const { plan } = await loadCopyJobManifest(env.DB, id);
  try {
    const result = await createCopyJob(env, {
      principal: { ...plan.principal, epoch: principal.epoch },
      requestId,
      sourceSpaceId: plan.source.spaceId,
      sourceNodeId: plan.source.rootId,
      destination: plan.destination,
      destinationParentId: plan.destinationParentId,
      name: plan.name,
      depth: plan.depth,
      ...(plan.overwrite ? { overwriteTargetId: plan.overwrite.rootId } : {}),
      lockTokens: [],
      retryOf: id,
    });
    // Another request may have won the unique successor slot during admission.
    return (await successor()) ?? result;
  } catch (error) {
    const accepted = await successor();
    if (accepted) return accepted;
    throw error;
  }
}
