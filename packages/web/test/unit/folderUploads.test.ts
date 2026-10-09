import { afterEach, expect, it, vi } from "vitest";
import type { Account } from "../../src/lib/api";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), enqueue: vi.fn(), capacity: vi.fn() }));
vi.mock("../../src/lib/api", () => ({ api: { mutation: mocks.mutation } }));
vi.mock("../../src/features/uploads/manager", () => ({
  uploads: { enqueue: mocks.enqueue, waitForCapacity: mocks.capacity },
}));

import { droppedEntries, uploadEntries } from "../../src/features/uploads/folders";

afterEach(() => vi.resetAllMocks());

it("drains paginated directory entries including empty folders", async () => {
  const file = (index: number) => ({
    name: `${index}.txt`,
    isFile: true,
    isDirectory: false,
    file: (resolve: (value: File) => void) => resolve(new File([String(index)], `${index}.txt`)),
  });
  const batches = [Array.from({ length: 100 }, (_, index) => file(index)), [file(100)], []];
  const root = {
    name: "stories",
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (resolve: (values: unknown[]) => void) => resolve(batches.shift()!),
    }),
  };
  const empty = {
    name: "empty",
    isDirectory: true,
    createReader: () => ({ readEntries: (resolve: (values: unknown[]) => void) => resolve([]) }),
  };
  const transfer = {
    items: [root, empty].map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => null,
    })),
  } as unknown as DataTransfer;
  const entries = await droppedEntries(transfer);
  expect(entries).toHaveLength(103);
  expect(entries.at(-2)?.path).toBe("stories/100.txt");
  expect(entries.at(-1)).toEqual({ path: "empty" });
});

it("creates each ancestor once and queues same-named files in their own directories", async () => {
  mocks.mutation
    .mockResolvedValueOnce({ result: { nodeId: "stories" } })
    .mockResolvedValueOnce({ result: { nodeId: "part" } })
    .mockResolvedValueOnce({ result: { nodeId: "empty" } });
  const one = new File(["one"], "chapter.txt"),
    two = new File(["two"], "chapter.txt");
  const signal = new AbortController().signal;
  const account = { id: "owner", spaceId: "space" } as Account;
  await uploadEntries(
    [
      { path: "stories/chapter.txt", file: one },
      { path: "stories/part/chapter.txt", file: two },
      { path: "stories/empty" },
    ],
    account,
    "root",
    () => {},
    signal,
  );
  expect(mocks.mutation.mock.calls.map((call) => call[2])).toEqual([
    { spaceId: "space", parentId: "root", name: "stories", kind: "folder" },
    { spaceId: "space", parentId: "stories", name: "part", kind: "folder" },
    { spaceId: "space", parentId: "stories", name: "empty", kind: "folder" },
  ]);
  expect(mocks.enqueue.mock.calls.map((call) => [call[0], call[2]])).toEqual([
    [one, "stories"],
    [two, "part"],
  ]);
  expect(mocks.capacity).toHaveBeenCalledTimes(2);
});

it("rejects malformed paths before creating any folders", async () => {
  await expect(
    uploadEntries(
      [{ path: "ok/file.txt", file: new File([""], "file.txt") }, { path: "bad/../file.txt" }],
      {} as Account,
      "root",
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("階層");
  expect(mocks.mutation).not.toHaveBeenCalled();
});
