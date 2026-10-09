import { type Account, api, type EncryptionFileMarker } from "./api";
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
let generation = 0;
let storageWork = Promise.resolve();
const LOCK_EVENT = "ncf-encryption-lock";
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LOCK_EVENT) clearEncryptionSession(false);
  });
}
function save(work: (store: EncryptionVaultStore) => Promise<void>) {
  storageWork = storageWork.then(() => work(new EncryptionVaultStore())).catch(() => undefined);
}

export function getEncryptionSession(accountId: string): EncryptionSession | null {
  return active?.accountId === accountId ? active.session : null;
}

export function setEncryptionSession(
  accountId: string,
  session: EncryptionSession | null,
  epoch = 0,
): void {
  clearEncryptionSession(!session);
  if (session) active = { accountId, session };
  const version = generation;
  if (session)
    save((store) =>
      generation === version ? store.putSession(accountId, epoch, session) : Promise.resolve(),
    );
  for (const listener of listeners) listener();
}

export function clearEncryptionSession(forget = true): void {
  generation++;
  active = null;
  if (forget) {
    save((store) => store.clearSessions());
    try {
      localStorage.setItem(LOCK_EVENT, crypto.randomUUID());
    } catch {
      /* Storage can be unavailable. */
    }
  }
  for (const revoke of revokers) {
    try {
      revoke();
    } catch {
      /* Continue clearing every independently registered resource. */
    }
  }
  for (const listener of listeners) listener();
}

/** Cached non-exportable CryptoKeys are scoped to the account and current epoch. */
export async function restoreEncryptionSession(account: Account): Promise<void> {
  const version = generation;
  await storageWork;
  const store = new EncryptionVaultStore();
  const [cached, vault] = await Promise.all([store.getSession(account.id), store.get(account.id)]);
  if (!cached || cached.epoch !== account.epoch || !vault || version !== generation) return;
  const { session } = cached;
  if (
    session.owner.privateKey.extractable ||
    session.owner.signing.privateKey.extractable ||
    session.owner.publicKey.fingerprint !== vault.recipient.fingerprint
  )
    return;
  const [owners, admins, pin] = await Promise.all([
    api.encryptionKeys(account.id),
    api.encryptionAdminKeys(),
    account.role === "app_admin"
      ? Promise.resolve(null)
      : store.getPinnedAdminRecipient(account.id),
  ]);
  const matches = (left: RecipientPublicKey, right: RecipientPublicKey) =>
    left.fingerprint === right.fingerprint && left.spki === right.spki;
  const ownerRegistered =
    owners.keys.length === 1 &&
    owners.keys[0]!.accountId === account.id &&
    matches(owners.keys[0]!.recipient, session.owner.publicKey) &&
    matches(owners.keys[0]!.signer, session.owner.signing);
  const admin = admins.keys.find((key) =>
    account.role === "app_admin"
      ? key.accountId === account.id &&
        matches(key.recipient, session.owner.publicKey) &&
        matches(key.signer, session.owner.signing)
      : pin &&
        key.accountId === pin.adminAccountId &&
        matches(key.recipient, pin.recipient) &&
        matches(key.signer, pin.signer),
  );
  if (version !== generation) return;
  active = {
    accountId: account.id,
    session: {
      ...session,
      ownerRegistered,
      adminRecipient: admin?.recipient ?? null,
      adminSigner: admin?.signer ?? null,
    },
  };
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
