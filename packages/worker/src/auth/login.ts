import { primary } from "../db/primary";
import type { AccessVerifier } from "./access";
import { type BootstrapPolicy, bootstrapOwner } from "./bootstrap";
import { registerAccessSession } from "./sessions";

/** Internal private-surface entry point. Route/host/CSRF middleware must precede HTTP exposure. */
export async function loginAccessUser(
  db: D1Database,
  verifier: AccessVerifier,
  request: Request,
  epoch: number,
  bootstrap: BootstrapPolicy,
) {
  const claims = await verifier.verify(request, "user");
  const initialized = await primary(db)
    .prepare("SELECT 1 AS ready FROM control WHERE singleton=1 AND bootstrap_done_at IS NOT NULL")
    .first();
  if (!initialized) await bootstrapOwner(db, claims, epoch, bootstrap);
  // After bootstrap, no implicit signup or email-based identity merge occurs here.
  return registerAccessSession(db, claims, epoch);
}
