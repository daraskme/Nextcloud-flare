import { resolveObjectURL } from "node:buffer";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, FileNode } from "../../src/lib/api";
import type { EncryptionSession } from "../../src/lib/encryptionSession";

// Run the real component with deterministic hooks, including cleanup before a state rerender.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps: unknown[]; cleanup: (() => void) | undefined }[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  pending: [] as (() => void)[],
  writes: [] as { index: number; value: unknown }[],
  failPublication: false,
  hash: vi.fn(async () => "a".repeat(64)),
  prepare: vi.fn(),
  cancel: vi.fn(async () => {}),
  decrypt: vi.fn(),
  readEncrypted: vi.fn(),
  request: vi.fn(),
  adopt: vi.fn(async () => {}),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        if (index === 5 && value !== null && hooks.failPublication) {
          hooks.failPublication = false;
          throw new Error("publication failed");
        }
        hooks.writes.push({ index, value });
        hooks.states[index] = value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ??= { current: initial });
  },
  useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) {
    return snapshot();
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (
      previous &&
      deps.length === previous.deps.length &&
      deps.every((dep, i) => Object.is(dep, previous.deps[i]))
    )
      return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({}),
  useInfiniteQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "encrypted-children"
      ? {
          data: {
            pages: [
              {
                children: [
                  {
                    id: "legacy",
                    name: "legacy.ncfenc",
                    currentBlobId: "blob",
                    revision: 1,
                    size: 14,
                    kind: "file",
                  },
                  {
                    id: "next",
                    name: "next.ncfenc",
                    currentBlobId: "blob-next",
                    revision: 1,
                    size: 14,
                    kind: "file",
                  },
                  {
                    id: "signed",
                    name: "signed.ncf",
                    currentBlobId: "blob-signed",
                    size: 14,
                    kind: "file",
                    encryption: {},
                  },
                  { id: "folder", name: "folder", kind: "folder", size: null },
                ],
              },
            ],
          },
        }
      : {},
}));
vi.mock("../../src/features/encryption/EncryptionSettings", () => ({
  EncryptionSettings: () => null,
}));
vi.mock("../../src/components/ui/button", () => ({ Button: "button" }));
vi.mock("../../src/features/uploads/manager", () => ({ uploads: {} }));
vi.mock("../../src/lib/clientMediaRegistration", () => ({ saveClientMedia: vi.fn() }));
vi.mock("../../src/lib/encryptedContent", () => ({ readEncryptedContent: hooks.readEncrypted }));
vi.mock("../../src/lib/api", () => ({
  formatBytes: String,
  api: {
    prepareContentSession: hooks.prepare,
    request: hooks.request,
    adoptLegacyEncryptedNode: hooks.adopt,
  },
}));
vi.mock("../../../shared/src/encryptionAttestation", () => ({
  encryptionHeaderHash: hooks.hash,
  legacyAdoptionPayload: vi.fn(() => new Uint8Array([1])),
}));
vi.mock("../../src/lib/encryptedContainer", () => ({
  readContainerHeaderLength: () => 2,
  parseContainerHeader: () => ({
    signed: false,
    totalBytes: 14,
    envelope: {
      cryptoId: "crypto",
      recipients: [{ fingerprint: "owner" }, { fingerprint: "admin" }],
    },
  }),
  openContainerHeader: async () => ({
    metadata: { name: "private.txt", mime: "text/plain" },
    envelope: { plainSize: 6 },
  }),
  decryptContainerPlainRange: hooks.decrypt,
}));

import { EncryptedFiles } from "../../src/features/encryption/EncryptedFiles";
import { clearEncryptionSession, setEncryptionSession } from "../../src/lib/encryptionSession";

const account = { id: "owner", rootNodeId: "root", role: "user", epoch: 1 } as Account;
const session = {
  ownerRegistered: true,
  owner: { publicKey: { fingerprint: "owner" }, signing: { privateKey: {} } },
  adminRecipient: { fingerprint: "admin" },
  adminSigner: {},
} as EncryptionSession;
const urls: string[] = [];
const chunks: Uint8Array[] = [];
const copiedChunks: Uint8Array[] = [];
const createObjectURL = URL.createObjectURL.bind(URL);
const NativeBlob = Blob;

type Element = ReactElement<Record<string, unknown>>;

function render() {
  hooks.stateIndex = hooks.refIndex = hooks.effectIndex = 0;
  const tree = EncryptedFiles({ account });
  while (hooks.pending.length) hooks.pending.shift()!();
  return tree;
}

function unmount() {
  for (const effect of hooks.effects) effect.cleanup?.();
}

function findAll(tree: ReactNode, predicate: (node: Element) => boolean): Element[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => findAll(child, predicate));
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [
    ...(predicate(element) ? [element] : []),
    ...findAll(element.props.children as ReactNode, predicate),
  ];
}

function button(tree: ReactNode, text: string, index = 0) {
  const result = findAll(tree, (node) => node.props.children === text)[index];
  expect(result).toBeDefined();
  return result!;
}

function click(element: Element) {
  return (element.props.onClick as () => void | Promise<void>)();
}

function review(tree: ReactNode) {
  return findAll(tree, (node) => node.props["aria-label"] === "旧形式ファイルの確認")[0];
}

async function inspect(tree = render(), index = 0) {
  click(button(tree, "旧形式を確認", index));
  await vi.waitFor(() => expect(urls).toHaveLength(1));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function pausedHash() {
  const hash = deferred<string>();
  hooks.hash.mockImplementationOnce(() => hash.promise);
  const tree = render();
  click(button(tree, "旧形式を確認"));
  await vi.waitFor(() => expect(hooks.hash).toHaveBeenCalledOnce());
  expect(urls).toHaveLength(0);
  expect(chunks[0]).toEqual(new Uint8Array(6));
  expect(copiedChunks[0]).toEqual(new Uint8Array(6));
  return hash;
}

async function expectSettledWithoutReview() {
  await vi.waitFor(() => expect(hooks.cancel).toHaveBeenCalledOnce());
  expect(review(render())).toBeUndefined();
  expect(hooks.writes.filter((write) => write.index === 5 && write.value !== null)).toHaveLength(0);
  expect(urls).toHaveLength(0);
}

beforeEach(() => {
  hooks.failPublication = false;
  hooks.states.length =
    hooks.refs.length =
    hooks.effects.length =
    hooks.pending.length =
    hooks.writes.length =
      0;
  vi.clearAllMocks();
  hooks.hash.mockImplementation(async () => "a".repeat(64));
  hooks.prepare.mockImplementation(async () => ({
    url: () => "https://content.test/file",
    cancel: hooks.cancel,
  }));
  hooks.decrypt.mockImplementation(async function* () {
    const bytes = new TextEncoder().encode("secret");
    chunks.push(bytes);
    yield bytes;
  });
  setEncryptionSession(account.id, session);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = createObjectURL(blob);
    urls.push(url);
    return url;
  });
  vi.stubGlobal(
    "Blob",
    class extends NativeBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        for (const part of parts) if (part instanceof Uint8Array) copiedChunks.push(part);
      }
    },
  );
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const match = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get("Range")!)!;
    const first = Number(match[1]);
    const last = Number(match[2]);
    const response = new Response(new Uint8Array(last - first + 1), {
      status: 206,
      headers: { ETag: '"etag"', "Content-Range": `bytes ${first}-${last}/14` },
    });
    Object.defineProperty(response, "url", { value: "https://content.test/file" });
    return response;
  });
});

afterEach(() => {
  unmount();
  clearEncryptionSession();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  chunks.length = copiedChunks.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("revokes the plaintext URL on unmount without a state rerender", async () => {
  await inspect();
  expect(await resolveObjectURL(urls[0]!)!.text()).toBe("secret");
  unmount();
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
});

it("revokes the plaintext URL synchronously on key lock before a state rerender", async () => {
  await inspect();
  clearEncryptionSession();
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  expect(review(render())).toBeUndefined();
});

it("closes a newly published URL from a stale render callback", async () => {
  const tree = render();
  await inspect(tree);
  click(button(tree, "旧形式を確認", 1));
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  await vi.waitFor(() => expect(urls).toHaveLength(2));
  expect(await resolveObjectURL(urls[1]!)!.text()).toBe("secret");
  unmount();
  expect(resolveObjectURL(urls[1]!)).toBeUndefined();
});

it("revokes a displayed URL on explicit close", async () => {
  await inspect();
  click(button(render(), "閉じる"));
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  expect(review(render())).toBeUndefined();
});

it("revokes a displayed URL when navigating folders", async () => {
  await inspect();
  click(button(render(), "フォルダーを開く"));
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  expect(review(render())).toBeUndefined();
});

it.each(["lock", "unmount", "folder", "close", "replace session"])(
  "does not publish a late dialog after %s during header hashing",
  async (action) => {
    const hash = await pausedHash();
    if (action === "lock") clearEncryptionSession();
    if (action === "unmount") unmount();
    if (action === "folder") {
      click(button(render(), "フォルダーを開く"));
    }
    if (action === "close") {
      click(button(render(), "復号して開く"));
      await vi.waitFor(() => expect(hooks.readEncrypted).toHaveBeenCalledOnce());
    }
    if (action === "replace session") setEncryptionSession(account.id, { ...session });
    hash.resolve("a".repeat(64));
    await vi.waitFor(() => expect(hooks.cancel).toHaveBeenCalledOnce());
    expect(hooks.writes.filter((write) => write.index === 5 && write.value !== null)).toHaveLength(
      0,
    );
    expect(urls).toHaveLength(0);
    if (action !== "unmount") expect(review(render())).toBeUndefined();
  },
);

it("does not let a stale hash completion replace or close the newer review", async () => {
  const hash = await pausedHash();
  click(button(render(), "旧形式を確認", 1));
  await vi.waitFor(() => expect(urls).toHaveLength(1));
  hash.reject(new Error("hash failed"));
  await vi.waitFor(() => expect(hooks.cancel).toHaveBeenCalledTimes(2));
  expect(review(render())).toBeDefined();
  expect(await resolveObjectURL(urls[0]!)!.text()).toBe("secret");
  expect(hooks.states[2]).toBe(false);
});

it("clears plaintext and publishes no URL when header hashing fails", async () => {
  hooks.hash.mockRejectedValueOnce(new Error("hash failed"));
  click(button(render(), "旧形式を確認"));
  await expectSettledWithoutReview();
  expect(chunks[0]).toEqual(new Uint8Array(6));
  expect(copiedChunks[0]).toEqual(new Uint8Array(6));
  expect(hooks.states[2]).toBe(false);
});

it("clears both original and accumulated plaintext when a later chunk fails", async () => {
  hooks.decrypt.mockImplementationOnce(async function* () {
    const bytes = new TextEncoder().encode("secret");
    chunks.push(bytes);
    yield bytes;
    throw new Error("authentication failed");
  });
  const fill = vi.spyOn(Uint8Array.prototype, "fill");
  click(button(render(), "旧形式を確認"));
  await expectSettledWithoutReview();
  expect(chunks[0]).toEqual(new Uint8Array(6));
  const wiped = fill.mock.contexts.filter(
    (bytes): bytes is Uint8Array => bytes instanceof Uint8Array && bytes.length === 6,
  );
  expect(wiped).toHaveLength(2);
  expect(wiped[0]).not.toBe(wiped[1]);
  expect(wiped.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});

it("clears accumulated plaintext if Blob construction fails", async () => {
  const captured: Uint8Array[] = [];
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: Uint8Array[]) {
        captured.push(...parts);
        throw new Error("Blob failed");
      }
    },
  );
  click(button(render(), "旧形式を確認"));
  await expectSettledWithoutReview();
  expect(chunks[0]).toEqual(new Uint8Array(6));
  expect(captured[0]).toEqual(new Uint8Array(6));
});

it("clears plaintext if URL creation fails and releases the content session", async () => {
  vi.spyOn(URL, "createObjectURL").mockImplementationOnce(() => {
    throw new Error("URL failed");
  });
  click(button(render(), "旧形式を確認"));
  await expectSettledWithoutReview();
  expect(chunks[0]).toEqual(new Uint8Array(6));
  expect(copiedChunks[0]).toEqual(new Uint8Array(6));
});

it("revokes a newly owned URL if state publication fails", async () => {
  hooks.failPublication = true;
  click(button(render(), "旧形式を確認"));
  await vi.waitFor(() => expect(hooks.cancel).toHaveBeenCalledOnce());
  expect(urls).toHaveLength(1);
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  expect(review(render())).toBeUndefined();
});

it("publishes a valid review only after header hashing completes", async () => {
  const hash = await pausedHash();
  hash.resolve("a".repeat(64));
  await vi.waitFor(() => expect(urls).toHaveLength(1));
  expect(review(render())).toBeDefined();
  expect(await resolveObjectURL(urls[0]!)!.text()).toBe("secret");
});

it("retains revocable URL ownership even if content cancellation fails", async () => {
  hooks.cancel.mockRejectedValueOnce(new Error("cancel failed"));
  await inspect();
  clearEncryptionSession();
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
});

it("preserves explicit legacy adoption and revokes its reviewed URL", async () => {
  await inspect();
  const tree = render();
  const confirm = findAll(tree, (node) => node.props.type === "checkbox")[0]!;
  (confirm.props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
  hooks.request.mockResolvedValueOnce({
    id: "legacy",
    ownerId: account.id,
    revision: 1,
    currentBlobId: "blob",
    encryption: null,
  } as FileNode);
  vi.spyOn(crypto.subtle, "sign").mockResolvedValueOnce(new Uint8Array([1]).buffer);
  const adopt = button(render(), "この旧形式に所有者署名を登録");
  expect(adopt.props.disabled).toBe(false);
  click(adopt);
  await vi.waitFor(() =>
    expect(hooks.adopt).toHaveBeenCalledWith(
      "legacy",
      expect.objectContaining({
        blobId: "blob",
        revision: 1,
        headerSha256: "a".repeat(64),
        requiredAdminFingerprint: "admin",
      }),
    ),
  );
  expect(resolveObjectURL(urls[0]!)).toBeUndefined();
  expect(review(render())).toBeUndefined();
});

it("preserves streaming preview ownership for signed content", async () => {
  const content = {
    close: vi.fn(async () => {}),
    media: vi.fn(async () => "/client-media/stream"),
    opened: { metadata: { name: "signed.png", mime: "image/png" }, envelope: { plainSize: 6 } },
  };
  hooks.readEncrypted.mockResolvedValueOnce(content);
  click(button(render(), "復号して開く"));
  await vi.waitFor(() => expect(hooks.states[4]).not.toBeNull());
  expect(content.media).toHaveBeenCalledWith("inline");
  expect(findAll(render(), (node) => node.props.src === "/client-media/stream")).toHaveLength(1);
  clearEncryptionSession();
  expect(content.close).toHaveBeenCalledOnce();
  expect(urls).toHaveLength(0);
});
