import { primary } from "../db/primary";
import type { AccountMutationEnv } from "../services/accountMutation";
import type { AccessVerifier } from "./access";
import { type BootstrapPolicy, bootstrapOwner } from "./bootstrap";
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
  // After bootstrap, no implicit signup or email-based identity merge occurs here.
  return registerAccessSession(env, claims, epoch);
}
