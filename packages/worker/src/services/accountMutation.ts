import type { Principal } from "../auth/authorize";
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

/** Admission fairness key: the acting user, or the link share for anonymous public access. */
export function principalActor(principal: Principal): string {
  return principal.kind === "link_share" ? `s:${principal.share_id}` : `u:${principal.user_id}`;
}
export const userActor = (userId: string): string => `u:${userId}`;
export const shareActor = (shareId: string): string => `s:${shareId}`;

/** Resolve the actor behind a stored credential; unknown credentials fall back to the owner. */
export async function credentialActor(
  db: D1Database,
  credentialId: string,
): Promise<string | undefined> {
  const row = await primary(db)
    .prepare(`SELECT COALESCE(
      'u:'||(SELECT s.user_id FROM sessions s WHERE s.id=c.session_id),
      'u:'||(SELECT ap.user_id FROM app_passwords ap WHERE ap.id=c.app_password_id),
      CASE WHEN ss.user_id IS NOT NULL THEN 'u:'||ss.user_id ELSE 's:'||ss.share_id END,
      'u:'||(SELECT sp.mapped_user_id FROM service_principals sp WHERE sp.id=c.service_principal_id)
    ) AS actor FROM credentials c LEFT JOIN share_sessions ss ON ss.id=c.share_session_id WHERE c.id=?`)
    .bind(credentialId)
    .first<string | null>("actor");
  return row ?? undefined;
}

/** Call after current authentication/preflight and expensive work. Shared content is billed to its owner's space; `actor` names who is asking (default: the owner). */
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
    | "invite.create"
    | "invite.revoke"
    | "invite.claim"
    | "share.create"
    | "share.update"
    | "share.disable"
    | "group.create"
    | "group.update"
    | "group.disable"
    | "node.star"
    | "recent.record"
    | "share.unlock"
    | "share.logout"
    | "content.budget"
    | "content.issue"
    | "content.accept"
    | "content.cancel"
    | "admin.files.read"
    | "encryption.key.challenge"
    | "encryption.key.register"
    | "encryption.file.adopt"
    | "encryption.admin.receipt"
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
    | "upload.multipart-journal-mirror"
    | "dav.put-start",
  actor?: string,
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
      ...(actor === undefined ? {} : { actor }),
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
