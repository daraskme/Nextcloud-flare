import { env } from "cloudflare:workers";
import {
  enqueueMutation,
  enqueueSystemMutation,
  type MutationAdmission,
  type MutationRequest,
  type SystemMutationAdmission,
} from "../../src/db/mutationAdmission";
import { grantPermit as grant } from "../../src/db/permits";
import type { SqlStatement } from "../../src/db/primary";
import type { Env } from "../../src/env";

/** Explicit immediate admission fixture; actual ControlDO FIFO/stop/restart is tested separately. */
export async function acquireMutation<Space extends string | null = string>(
  request: MutationRequest<Space>,
  db = env.DB,
): Promise<MutationAdmission<Space>> {
  const receipt = await enqueueMutation(db, request);
  if (
    receipt.state !== "active" ||
    receipt.expires_at === null ||
    receipt.space_id !== request.spaceId
  )
    throw new Error("fixture_mutation_waiting");
  return { ...receipt, space_id: request.spaceId, expires_at: receipt.expires_at };
}

export async function acquireSystemMutation(
  request: MutationRequest,
  db = env.DB,
): Promise<SystemMutationAdmission> {
  const maintenance = await db
    .prepare("SELECT maintenance FROM control WHERE singleton=1")
    .first<0 | 1>("maintenance");
  if (maintenance !== 0 && maintenance !== 1) throw new Error("fixture_control_missing");
  const receipt = await enqueueSystemMutation(db, { ...request, system: 1, maintenance });
  if (
    receipt.state !== "active" ||
    receipt.expires_at === null ||
    receipt.space_id !== request.spaceId
  )
    throw new Error("fixture_mutation_waiting");
  return {
    ...receipt,
    space_id: request.spaceId,
    expires_at: receipt.expires_at,
    system: 1,
    maintenance,
  };
}

/** Domain-batch fault injection is independent of the admission backend. */
export function mutationEnv(db = env.DB, admissionDb = env.DB): Env {
  return {
    ...env,
    DB: db,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: (request: MutationRequest) => acquireMutation(request, admissionDb),
        acquireSystemMutation: (request: MutationRequest) =>
          acquireSystemMutation(request, admissionDb),
        status: async () => {
          const row = await admissionDb
            .prepare("SELECT epoch,maintenance,gc_paused FROM control WHERE singleton=1")
            .first<{ epoch: number; maintenance: number; gc_paused: number }>();
          if (!row) throw new Error("fixture_control_missing");
          return {
            epoch: row.epoch,
            maintenance: row.maintenance === 1,
            gcPaused: row.gc_paused === 1,
          };
        },
        acquireBootstrapMutation: (request: Omit<MutationRequest, "spaceId">) =>
          acquireMutation({ ...request, spaceId: null }, admissionDb),
      }),
    } as unknown as Env["CONTROL"],
  };
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
