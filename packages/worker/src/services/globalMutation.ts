import {
  assertGlobalMutationAdmission,
  commitGlobalMutationAdmission,
  type GlobalMutationAdmission,
  type GlobalMutationKind,
  hasCommittedGlobalMutation,
} from "../db/mutationAdmission";
import { atomicBatch, type SqlStatement } from "../db/primary";
import type { ControlDO } from "../do/ControlDO";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";
import { MutationUnavailableError } from "./accountMutation";
import type { SystemMutationSource } from "./systemMutation";

export type GlobalMutationSource =
  | Pick<Env, "DB" | "CONTROL">
  | {
      DB: D1Database;
      systemControl: Pick<ControlDO, "status" | "acquireGlobalMutation">;
    };
export type InventoryMutationSource = GlobalMutationSource & SystemMutationSource;

/** Internal ownerless work only. Domain source, token, lease and epoch proofs remain mandatory. */
export async function acquireGlobalMutation(
  env: GlobalMutationSource,
  kind: GlobalMutationKind,
  deadline = Date.now() + 5000,
): Promise<GlobalMutationAdmission> {
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
    throw new MutationUnavailableError();
  const permitId = "global:" + kind + ":" + crypto.randomUUID();
  try {
    const control =
      "systemControl" in env
        ? env.systemControl
        : env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
    const { epoch } = await control.status();
    const admission = await control.acquireGlobalMutation({
      permitId,
      epoch,
      deadline: Math.min(deadline, Date.now() + 5000),
    });
    if (
      admission.permit_id !== permitId ||
      admission.space_id !== null ||
      admission.epoch !== epoch ||
      admission.system !== 1 ||
      ![0, 1].includes(admission.maintenance)
    )
      throw new MutationUnavailableError();
    return admission;
  } catch {
    throw new MutationUnavailableError();
  }
}

/** Use raw atomicBatch for external dispatch; a recovered receipt never authorizes I/O. */
export function globalMutationStatements(
  admission: GlobalMutationAdmission,
  statements: readonly SqlStatement[],
): readonly SqlStatement[] {
  return [
    assertGlobalMutationAdmission(admission),
    ...statements,
    ...commitGlobalMutationAdmission(admission),
  ];
}

/** DB-only facts may recover the exact committed receipt. This does not prove external completion. */
export async function commitGlobalMutation(
  db: D1Database,
  admission: GlobalMutationAdmission,
  statements: readonly SqlStatement[],
): Promise<void> {
  try {
    await atomicBatch(db, globalMutationStatements(admission, statements));
  } catch (error) {
    if (!(await hasCommittedGlobalMutation(db, admission))) throw error;
  }
}
