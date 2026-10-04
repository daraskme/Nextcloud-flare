import type { EncryptionFileMarker } from "./api";
import type { RecipientPublicKey, UnlockedRecipient } from "./cryptoEnvelope";
import { EncryptionVaultStore } from "./encryptionVaultStore";

export interface EncryptionSession {
  readonly owner: UnlockedRecipient;
  /** Owner identity was matched to the current server key registry. */
  readonly ownerRegistered: boolean;
  /** Null permits recovery reads; new writes require a pinned administrator key. */
  readonly adminRecipient: RecipientPublicKey | null;
  /** Registry signer key paired with the administrator RSA recipient key. */
  readonly adminSigner: RecipientPublicKey | null;
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

export function isEncryptedFile(node: {
  readonly name?: string;
  readonly encryption?: EncryptionFileMarker | null;
}): boolean {
  return node.encryption !== undefined && node.encryption !== null;
}
