import { env } from "cloudflare:workers";
import {
  enqueueMutation,
  type MutationAdmission,
  type MutationRequest,
} from "../../src/db/mutationAdmission";
import { grantPermit as grant } from "../../src/db/permits";
import type { SqlStatement } from "../../src/db/primary";

/** Explicit namespace-only fixture; actual ControlDO FIFO/stop/restart is tested separately. */
export async function acquireMutation(request: MutationRequest): Promise<MutationAdmission> {
  const receipt = await enqueueMutation(env.DB, request);
  if (receipt.state !== "active" || receipt.expires_at === null)
    throw new Error("fixture_mutation_waiting");
  return { ...receipt, expires_at: receipt.expires_at };
}

export async function grantPermit(
  db: D1Database,
  requestId: string,
  spaceId: string,
  epoch: number,
  leaseMs?: number,
  guards: readonly SqlStatement[] = [],
) {
  const admission = await acquireMutation({
    permitId: requestId,
    spaceId,
    epoch,
    deadline: Date.now() + 5000,
  });
  return grant(db, requestId, spaceId, epoch, admission, leaseMs, guards);
}
