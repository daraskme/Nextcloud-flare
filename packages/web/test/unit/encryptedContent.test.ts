import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Account, FileNode } from "../../src/lib/api";
import { createRecipientVault } from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
} from "../../src/lib/encryptedContainer";

const mocked = vi.hoisted(() => ({
  session: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../../src/lib/encryptionSession", () => ({
  getEncryptionSession: mocked.session,
  onEncryptionLock: () => () => {},
}));
vi.mock("../../src/lib/api", () => ({
  api: { prepareContentSession: mocked.prepare },
}));

import { readEncryptedContent } from "../../src/lib/encryptedContent";

const SOURCE = "https://content.example.test/c/node-1/blob-1";
const ETAG = '"revision-1"';
const account = { id: "owner_user", epoch: 1 } as Account;
let bytes: Uint8Array;
let node: FileNode;
let session: { owner: Awaited<ReturnType<typeof createRecipientVault>>["unlocked"] };

beforeAll(async () => {
  const owner = await createRecipientVault(account.id);
  session = { owner: owner.unlocked };
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
  const made = await createEncryptedContainer(source, [owner.unlocked.publicKey], writer);
  bytes = new Uint8Array(await made.file.arrayBuffer());
  node = {
    id: "node-1",
    name: made.file.name,
    size: bytes.length,
    currentBlobId: "blob-1",
  } as FileNode;
}, 30_000);

afterEach(() => {
  mocked.session.mockReset();
  mocked.prepare.mockReset();
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

it("rejects a contradictory present Content-Length", async () => {
  const fetcher = setup("wrong");
  await expect(readEncryptedContent(account, node)).rejects.toThrow("配信情報");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
