import {
  assertMutationAdmission,
  commitMutationAdmission,
  hasCommittedMutation,
  type MutationAdmission,
} from "../db/mutationAdmission";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import { CONTROL_NAME } from "../do/ControlDO";
import type { Env } from "../env";

export type AccountMutationEnv = Pick<Env, "DB" | "CONTROL">;
export class MutationUnavailableError extends Error {
  constructor() {
    super("mutation_unavailable");
    this.name = "MutationUnavailableError";
  }
}

/** Only call after the operation's authentication/preflight and expensive KDF work. */
export async function acquireAccountMutation(
  env: AccountMutationEnv,
  userId: string,
  epoch: number,
  kind: "app-password.create" | "app-password.revoke" | "app-password.rotate",
): Promise<MutationAdmission> {
  const spaceId = await primary(env.DB)
    .prepare(
      "SELECT s.id FROM spaces s JOIN users u ON u.id=s.owner_id WHERE u.id=? AND u.disabled_at IS NULL",
    )
    .bind(userId)
    .first<string>("id");
  if (!spaceId) throw new MutationUnavailableError();
  try {
    return await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).acquireMutation({
      permitId: `${kind}:${crypto.randomUUID()}`,
      spaceId,
      epoch,
      deadline: Date.now() + 5000,
    });
  } catch {
    throw new MutationUnavailableError();
  }
}

/** SQL stays local to the service: only the typed ticket request crosses the ControlDO RPC. */
export async function commitAccountMutation(
  db: D1Database,
  admission: MutationAdmission,
  userId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  try {
    await atomicBatch(db, [
      assertMutationAdmission(admission),
      assertExists(
        "SELECT 1 FROM spaces s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND u.id=? AND u.disabled_at IS NULL",
        [admission.space_id, userId],
      ),
      ...statements,
      ...commitMutationAdmission(admission),
    ]);
  } catch (error) {
    if (!(await hasCommittedMutation(db, admission))) throw error;
  }
}
