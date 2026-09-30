import {
  assertSystemMutationAdmission,
  commitSystemMutationAdmission,
  hasCommittedSystemMutation,
  type SystemMutationAdmission,
  type SystemMutationKind,
} from "../db/mutationAdmission";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { ControlDO } from "../do/ControlDO";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";
import { MutationUnavailableError } from "./accountMutation";

export type SystemMutationEnv = Pick<Env, "DB" | "CONTROL">;
/** Recovery inside ControlDO calls the same coordinator directly, without an RPC to itself. */
export type SystemMutationSource =
  | SystemMutationEnv
  | { DB: D1Database; systemControl: Pick<ControlDO, "status" | "acquireSystemMutation"> };

/** External storage facts remain necessary after revocation/disable/stop. Domain proofs stay local. */
export async function acquireSystemMutation(
  env: SystemMutationSource,
  ownerId: string,
  kind: SystemMutationKind,
  deadline = Date.now() + 5000,
): Promise<SystemMutationAdmission> {
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
    throw new MutationUnavailableError();
  const spaceId = await primary(env.DB)
    .prepare("SELECT s.id FROM spaces s JOIN users u ON u.id=s.owner_id WHERE u.id=?")
    .bind(ownerId)
    .first<string>("id");
  if (!spaceId) throw new MutationUnavailableError();
  const permitId = "system:" + kind + ":" + crypto.randomUUID();
  try {
    const control =
      "systemControl" in env
        ? env.systemControl
        : env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
    const { epoch } = await control.status();
    const admission = await control.acquireSystemMutation({
      permitId,
      spaceId,
      epoch,
      deadline: Math.min(deadline, Date.now() + 5000),
    });
    if (
      admission.permit_id !== permitId ||
      admission.space_id !== spaceId ||
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

/** External dispatch claims still need direct batch ACK; use these statements without receipt recovery. */
export function systemMutationStatements(
  admission: SystemMutationAdmission,
  ownerId: string,
  statements: readonly SqlStatement[],
): readonly SqlStatement[] {
  return [
    assertSystemMutationAdmission(admission),
    assertExists("SELECT 1 FROM spaces s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND u.id=?", [
      admission.space_id,
      ownerId,
    ]),
    ...statements,
    ...commitSystemMutationAdmission(admission),
  ];
}

/** DB-only fact/stop receipt. This does not prove that external I/O has ended or permit a refund. */
export async function commitSystemMutation(
  db: D1Database,
  admission: SystemMutationAdmission,
  ownerId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  try {
    await atomicBatch(db, systemMutationStatements(admission, ownerId, statements));
  } catch (error) {
    if (!(await hasCommittedSystemMutation(db, admission))) throw error;
  }
}
