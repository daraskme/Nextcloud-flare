import type { AuthenticatedAppPassword } from "../auth/appPassword.js";
import type { AuthenticatedUser } from "../auth/httpAuth.js";
import type { Env } from "../env.js";
import { claimOperation } from "../services/operations.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface MutationLease {
  operationId: string;
  permitId: string;
  epoch: number;
  auditId: string;
  outboxId: string;
  release: () => Promise<void>;
  revoke: () => Promise<void>;
}

export async function acquireMutation(
  env: Env,
  user: AuthenticatedUser | AuthenticatedAppPassword,
  input: {
    spaceId: string;
    kind: string;
    expectedSteps: number;
    intent: unknown;
    nodeIds?: string[];
    lockTokenDigests?: string[];
  },
): Promise<MutationLease> {
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) {
    throw new Error("control_unavailable");
  }
  const permitId = randomId("pmt");
  const operationId = randomId("op");
  const stub = env.LOCKS.get(env.LOCKS.idFromName(input.spaceId));
  const response = await stub.fetch("https://lock.internal/permits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      permitId,
      spaceId: input.spaceId,
      epoch: control.epoch,
      ttlMs: 30_000,
      nodeIds: input.nodeIds ?? [],
      creatorUserId: user.principal.userId,
      lockTokenDigests: input.lockTokenDigests ?? [],
    }),
  });
  if (!response.ok) {
    throw new Error(response.status === 423 ? "locked" : "permit_denied");
  }
  const permit: { expires_at: number } = await response.json();
  const appPassword = "sessionId" in user;
  await claimOperation(env, {
    operationId,
    permitId,
    spaceId: input.spaceId,
    userId: user.principal.userId,
    sessionId: appPassword ? user.sessionId : user.principal.sessionId,
    credentialKind: appPassword ? "app_password" : "access",
    credentialId: user.principal.credentialId,
    ...(appPassword ? { appPasswordId: user.principal.appPasswordId } : {}),
    epoch: control.epoch,
    kind: input.kind,
    requestDigest: await digest(input.intent),
    expectedSteps: input.expectedSteps,
    permitExpiresAt: permit.expires_at,
  });
  const close = async (action: "release" | "revoke") => {
    await stub.fetch(`https://lock.internal/permits/${permitId}/${action}`, { method: "POST" });
  };
  return {
    operationId,
    permitId,
    epoch: control.epoch,
    auditId: randomId("aud"),
    outboxId: randomId("out"),
    release: () => close("release"),
    revoke: () => close("revoke"),
  };
}
