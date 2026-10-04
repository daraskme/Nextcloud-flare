import { primary } from "../db/primary";
import type { AccountMutationEnv } from "../services/accountMutation";
import type { AccessVerifier } from "./access";
import { type BootstrapPolicy, bootstrapOwner } from "./bootstrap";
import { claimAccessInvite } from "./invites";
import { registerAccessSession } from "./sessions";

/** Internal private-surface entry point. Route/host/CSRF middleware must precede HTTP exposure. */
export async function loginAccessUser(
  env: AccountMutationEnv,
  verifier: AccessVerifier,
  request: Request,
  epoch: number,
  bootstrap: BootstrapPolicy,
) {
  const claims = await verifier.verify(request, "user");
  const initialized = await primary(env.DB)
    .prepare("SELECT 1 AS ready FROM control WHERE singleton=1 AND bootstrap_done_at IS NOT NULL")
    .first();
  if (!initialized) await bootstrapOwner(env, claims, epoch, bootstrap);
  else {
    const existing = await primary(env.DB)
      .prepare("SELECT 1 FROM users WHERE access_iss=? AND access_sub=?")
      .bind(claims.iss, claims.sub)
      .first();
    if (!existing) await claimAccessInvite(env, claims, epoch);
  }
  return registerAccessSession(env, claims, epoch);
}
