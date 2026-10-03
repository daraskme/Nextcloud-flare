import type { RecipientPublicKey, UnlockedRecipient } from "./cryptoEnvelope";
import { EncryptionVaultStore } from "./encryptionVaultStore";

export interface EncryptionSession {
  readonly owner: UnlockedRecipient;
  /** Null permits recovery reads; new writes require a pinned administrator key. */
  readonly adminRecipient: RecipientPublicKey | null;
}

let active: { accountId: string; session: EncryptionSession } | null = null;
const listeners = new Set<() => void>();
const revokers = new Set<() => void>();

export function getEncryptionSession(accountId: string): EncryptionSession | null {
  return active?.accountId === accountId ? active.session : null;
}

export function setEncryptionSession(accountId: string, session: EncryptionSession | null): void {
  clearEncryptionSession();
  if (session) active = { accountId, session };
  for (const listener of listeners) listener();
}

export function clearEncryptionSession(): void {
  active = null;
  for (const revoke of revokers) {
    try {
      revoke();
    } catch {
      /* Continue clearing every independently registered resource. */
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeEncryptionSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Revokes already prepared plaintext media when keys are locked or the account changes. */
export function onEncryptionLock(revoke: () => void): () => void {
  revokers.add(revoke);
  return () => {
    revokers.delete(revoke);
  };
}

export async function encryptionConfigured(accountId: string): Promise<boolean> {
  return (await new EncryptionVaultStore().get(accountId)) !== null;
}

export function isEncryptedFile(name: string): boolean {
  return /^[A-Za-z0-9_-]{22}\.ncf$/.test(name);
}
