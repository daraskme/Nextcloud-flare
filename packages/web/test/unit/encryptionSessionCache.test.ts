import { afterEach, expect, it, vi } from "vitest";
import type { Account } from "../../src/lib/api";
import type { EncryptionSession } from "../../src/lib/encryptionSession";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSession: vi.fn(),
  putSession: vi.fn(),
  clearSessions: vi.fn(),
  getPinnedAdminRecipient: vi.fn(),
  owners: vi.fn(),
  admins: vi.fn(),
}));
vi.mock("../../src/lib/encryptionVaultStore", () => ({
  EncryptionVaultStore: class {
    get = mocks.get;
    getSession = mocks.getSession;
    putSession = mocks.putSession;
    clearSessions = mocks.clearSessions;
    getPinnedAdminRecipient = mocks.getPinnedAdminRecipient;
  },
}));
vi.mock("../../src/lib/api", () => ({
  api: { encryptionKeys: mocks.owners, encryptionAdminKeys: mocks.admins },
}));

import {
  clearEncryptionSession,
  getEncryptionSession,
  restoreEncryptionSession,
  setEncryptionSession,
} from "../../src/lib/encryptionSession";

const owner = {
  privateKey: { extractable: false },
  publicKey: { fingerprint: "rsa", spki: "rsa-spki" },
  signing: { privateKey: { extractable: false }, fingerprint: "sign", spki: "sign-spki" },
};
const keys = {
  owner,
  ownerRegistered: true,
  adminRecipient: owner.publicKey,
  adminSigner: owner.signing,
} as unknown as EncryptionSession;
const account = { id: "owner", epoch: 3, role: "app_admin" } as Account;
afterEach(() => {
  clearEncryptionSession(false);
  vi.resetAllMocks();
});
function fixture() {
  mocks.get.mockResolvedValue({ recipient: owner.publicKey });
  mocks.getSession.mockResolvedValue({ accountId: account.id, epoch: 3, session: keys });
  mocks.owners.mockResolvedValue({
    keys: [{ accountId: account.id, recipient: owner.publicKey, signer: owner.signing }],
  });
  mocks.admins.mockResolvedValue({
    keys: [{ accountId: account.id, recipient: owner.publicKey, signer: owner.signing }],
  });
}
it("restores cached non-exportable keys after verifying the current registry", async () => {
  fixture();
  await restoreEncryptionSession(account);
  expect(getEncryptionSession(account.id)).toMatchObject(keys);
  expect(getEncryptionSession("another-account")).toBeNull();
});
it("does not restore a previous epoch or a cache without its vault", async () => {
  fixture();
  await restoreEncryptionSession({ ...account, epoch: 4 });
  expect(getEncryptionSession(account.id)).toBeNull();
  expect(mocks.owners).not.toHaveBeenCalled();
  mocks.get.mockResolvedValue(null);
  await restoreEncryptionSession(account);
  expect(getEncryptionSession(account.id)).toBeNull();
});
it("does not revive keys when locked while registry verification is in flight", async () => {
  fixture();
  let finish!: (value: unknown) => void;
  mocks.owners.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const restored = restoreEncryptionSession(account);
  await vi.waitFor(() => expect(mocks.owners).toHaveBeenCalled());
  clearEncryptionSession();
  finish({ keys: [{ accountId: account.id, recipient: owner.publicKey, signer: owner.signing }] });
  await restored;
  expect(getEncryptionSession(account.id)).toBeNull();
  expect(mocks.clearSessions).toHaveBeenCalled();
});
it("persists unlocks but clears cached keys when explicitly locked", async () => {
  setEncryptionSession(account.id, keys, account.epoch);
  await vi.waitFor(() => expect(mocks.putSession).toHaveBeenCalledWith(account.id, 3, keys));
  setEncryptionSession(account.id, null, account.epoch);
  await vi.waitFor(() => expect(mocks.clearSessions).toHaveBeenCalled());
  expect(getEncryptionSession(account.id)).toBeNull();
});
