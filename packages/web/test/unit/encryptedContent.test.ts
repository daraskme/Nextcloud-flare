import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { encryptionHeaderHash } from "../../../shared/src/encryptionAttestation";
import type { Account, FileNode } from "../../src/lib/api";
import { createRecipientVault } from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
} from "../../src/lib/encryptedContainer";

const mocked = vi.hoisted(() => ({
  session: vi.fn(),
  prepare: vi.fn(),
  encryptionKeys: vi.fn(),
  encryptionAdminKeys: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("../../src/lib/encryptionSession", () => ({
  getEncryptionSession: mocked.session,
  onEncryptionLock: () => () => {},
}));
vi.mock("../../src/lib/api", () => ({
  api: {
    prepareContentSession: mocked.prepare,
    encryptionKeys: mocked.encryptionKeys,
    encryptionAdminKeys: mocked.encryptionAdminKeys,
    recordAdminEncryptionReceipt: mocked.receipt,
  },
}));

import { readEncryptedContent } from "../../src/lib/encryptedContent";

const SOURCE = "https://content.example.test/c/node-1/blob-1";
const ETAG = '"revision-1"';
const account = { id: "owner_user", epoch: 1 } as Account;
let bytes: Uint8Array;
let node: FileNode;
let session: {
  owner: Awaited<ReturnType<typeof createRecipientVault>>["unlocked"];
  ownerRegistered: boolean;
  adminRecipient: { fingerprint: string; spki: string } | null;
  adminSigner: { fingerprint: string; spki: string };
};
let ownerRegistration: {
  accountId: string;
  recipient: { fingerprint: string; spki: string };
  signer: { fingerprint: string; spki: string };
  registeredAt: number;
};
let adminRegistration: {
  accountId: string;
  recipient: { fingerprint: string; spki: string };
  signer: { fingerprint: string; spki: string };
  registeredAt: number;
};

beforeAll(async () => {
  const owner = await createRecipientVault(account.id);
  const admin = await createRecipientVault("admin_user");
  session = {
    owner: owner.unlocked,
    ownerRegistered: true,
    adminRecipient: admin.unlocked.publicKey,
    adminSigner: {
      fingerprint: admin.unlocked.signing.fingerprint,
      spki: admin.unlocked.signing.spki,
    },
  };
  ownerRegistration = {
    accountId: account.id,
    recipient: owner.unlocked.publicKey,
    signer: {
      fingerprint: owner.unlocked.signing.fingerprint,
      spki: owner.unlocked.signing.spki,
    },
    registeredAt: 1,
  };
  adminRegistration = {
    accountId: "admin_user",
    recipient: admin.unlocked.publicKey,
    signer: {
      fingerprint: admin.unlocked.signing.fingerprint,
      spki: admin.unlocked.signing.spki,
    },
    registeredAt: 1,
  };
  const writer: ContainerWriterFactory = async (name) => {
    const parts: Uint8Array[] = [];
    return {
      async write(part) {
        parts.push(new Uint8Array(part));
      },
      async close() {
        return new File(
          parts.map((part) => new Uint8Array(part)),
          name,
        );
      },
      async discard() {
        parts.length = 0;
      },
    };
  };
  const source = new File([new Uint8Array([1, 2, 3])], "private.png", {
    type: "image/png",
  });
  const made = await createEncryptedContainer(
    source,
    [owner.unlocked.publicKey, admin.unlocked.publicKey],
    writer,
    undefined,
    { ownerId: account.id, signer: owner.unlocked.signing },
  );
  bytes = new Uint8Array(await made.file.arrayBuffer());
  const headerSha256 = await encryptionHeaderHash(new Uint8Array(made.headerBytes));
  node = {
    id: "node-1",
    name: made.file.name,
    size: bytes.length,
    currentBlobId: "blob-1",
    ownerId: account.id,
    revision: 1,
    encryption: {
      formatVersion: 2,
      headerSha256,
      cryptoId: made.header.envelope.cryptoId,
      ownerId: account.id,
      signerFingerprint: owner.unlocked.signing.fingerprint,
      signerRsaFingerprint: owner.unlocked.publicKey.fingerprint,
      requiredAdminFingerprint: admin.unlocked.publicKey.fingerprint,
      adminReceiptState: "pending",
      legacyAttestation: false,
      ownerSignature: null,
    },
  } as FileNode;
  mocked.encryptionKeys.mockResolvedValue({
    keys: [ownerRegistration],
  });
}, 30_000);

afterEach(() => {
  mocked.session.mockReset();
  mocked.prepare.mockReset();
  mocked.encryptionKeys.mockClear();
  mocked.receipt.mockReset();
  vi.unstubAllGlobals();
});

function sourceResponse(first: number, last: number, contentLength: string | null): Response {
  const body = bytes.slice(first, last + 1);
  const headers = new Headers({
    ETag: ETAG,
    "Content-Range": `bytes ${first}-${last}/${bytes.length}`,
  });
  if (contentLength !== null) headers.set("Content-Length", contentLength);
  const response = new Response(body, { status: 206, headers });
  Object.defineProperty(response, "url", { value: SOURCE });
  return response;
}

function setup(contentLength: "absent" | "correct" | "wrong") {
  mocked.session.mockReturnValue(session);
  mocked.prepare.mockResolvedValue({ url: () => SOURCE, cancel: vi.fn() });
  mocked.encryptionKeys.mockResolvedValue({ keys: [ownerRegistration] });
  mocked.encryptionAdminKeys.mockResolvedValue({
    keys: [adminRegistration],
  });
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("Range") ?? "");
    if (!match) throw new Error("unexpected_range");
    const first = Number(match[1]);
    const last = Number(match[2]);
    return sourceResponse(
      first,
      last,
      contentLength === "absent"
        ? null
        : String(last - first + (contentLength === "wrong" ? 2 : 1)),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("opens exact 206 ciphertext ranges when a streamed response omits Content-Length", async () => {
  const fetcher = setup("absent");
  const opened = await readEncryptedContent(account, node);
  expect(opened.opened.metadata.name).toBe("private.png");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await opened.close();
});

it("keeps owner recovery reads available after the local administrator pin is removed", async () => {
  const original = session;
  session = { ...session, adminRecipient: null };
  try {
    setup("absent");
    const opened = await readEncryptedContent(account, node);
    expect(opened.opened.metadata.name).toBe("private.png");
    await opened.close();
  } finally {
    session = original;
  }
});

it("rejects a contradictory present Content-Length", async () => {
  const fetcher = setup("wrong");
  await expect(readEncryptedContent(account, node)).rejects.toThrow("配信情報");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
