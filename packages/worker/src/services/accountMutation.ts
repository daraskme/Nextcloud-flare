import {
  assertMutationAdmission,
  commitMutationAdmission,
  hasCommittedMutation,
  type MutationAdmission,
} from "../db/mutationAdmission";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";

export type AccountMutationEnv = Pick<Env, "DB" | "CONTROL">;
export class MutationUnavailableError extends Error {
  constructor() {
    super("mutation_unavailable");
    this.name = "MutationUnavailableError";
  }
}

/** Call after current authentication/preflight and expensive work. Shared content uses its owner, not the viewer. */
export async function acquireAccountMutation(
  env: AccountMutationEnv,
  ownerId: string,
  epoch: number,
  kind:
    | "app-password.create"
    | "app-password.revoke"
    | "app-password.rotate"
    | "session.register"
    | "session.revoke"
    | "content.budget"
    | "content.issue"
    | "content.accept"
    | "content.cancel"
    | "upload.reserve"
    | "upload.single-start"
    | "upload.single-recover"
    | "upload.single-verify"
    | "upload.multipart-start"
    | "upload.multipart-complete"
    | "upload.single-abort"
    | "upload.multipart-abort"
    | "upload.multipart-verify"
    | "upload.multipart-journal-init"
    | "upload.multipart-journal-mirror",
): Promise<MutationAdmission> {
  const spaceId = await primary(env.DB)
    .prepare(
      "SELECT s.id FROM spaces s JOIN users u ON u.id=s.owner_id WHERE u.id=? AND (u.disabled_at IS NULL OR ?=1)",
    )
    .bind(ownerId, kind === "session.revoke" ? 1 : 0)
    .first<string>("id");
  if (!spaceId) throw new MutationUnavailableError();
  const permitId = `${kind}:${crypto.randomUUID()}`;
  try {
    const admission = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).acquireMutation({
      permitId,
      spaceId,
      epoch,
      deadline: Date.now() + 5000,
    });
    if (
      admission.permit_id !== permitId ||
      admission.space_id !== spaceId ||
      admission.epoch !== epoch
    )
      throw new MutationUnavailableError();
    return admission;
  } catch {
    throw new MutationUnavailableError();
  }
}

/** Dispatch claims use the batch directly: receipt readback must never authorize external writes. */
export function accountMutationStatements(
  admission: MutationAdmission,
  ownerId: string,
  statements: readonly SqlStatement[],
  options: { allowDisabled?: boolean } = {},
): readonly SqlStatement[] {
  return [
    assertMutationAdmission(admission),
    assertExists(
      "SELECT 1 FROM spaces s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND u.id=? AND (u.disabled_at IS NULL OR ?=1)",
      [admission.space_id, ownerId, options.allowDisabled ? 1 : 0],
    ),
    ...statements,
    ...commitMutationAdmission(admission),
  ];
}

/** Recover a DB-only update from its exact receipt; external dispatch requires a direct batch ACK. */
export async function commitAccountMutation(
  db: D1Database,
  admission: MutationAdmission,
  ownerId: string,
  statements: readonly SqlStatement[],
  options: { allowDisabled?: boolean } = {},
): Promise<void> {
  try {
    await atomicBatch(db, accountMutationStatements(admission, ownerId, statements, options));
  } catch (error) {
    if (!(await hasCommittedMutation(db, admission))) throw error;
  }
}
