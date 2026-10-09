import { type Account, api } from "../../lib/api";
import { uploads } from "./manager";

export type UploadEntry = { path: string; file?: File };

export function selectedEntries(files: FileList | File[]): UploadEntry[] {
  return Array.from(files).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** Drain every readEntries batch: Chromium returns at most 100 entries per call. */
export async function droppedEntries(transfer: DataTransfer): Promise<UploadEntry[]> {
  const roots = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const result: UploadEntry[] = [];
  async function visit(entry: FileSystemEntry, parent: string) {
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      result.push({ path, file });
    } else if (entry.isDirectory) {
      result.push({ path });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!children.length) break;
        for (const child of children) await visit(child, `${path}/`);
      }
    }
  }
  if (!roots.length) return selectedEntries(transfer.files);
  for (const root of roots) {
    if (root.entry) await visit(root.entry, "");
    else if (root.file) result.push({ path: root.file.name, file: root.file });
  }
  return result;
}

export async function uploadEntries(
  entries: UploadEntry[],
  account: Account,
  parentId: string,
  progress: (message: string) => void,
  signal: AbortSignal,
) {
  const folders = new Map<string, string>([["", parentId]]);
  const paths = entries.map((entry) => {
    const parts = entry.path.split("/");
    if (
      parts.length > 64 ||
      parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part))
    )
      throw new Error("フォルダーの階層または名前を確認してください。");
    return { ...entry, parts };
  });
  let count = 0;
  for (const entry of paths) {
    signal.throwIfAborted();
    const directoryParts = entry.file ? entry.parts.slice(0, -1) : entry.parts;
    let path = "";
    for (const name of directoryParts) {
      const next = path ? `${path}/${name}` : name;
      if (!folders.has(next)) {
        progress(`フォルダーを作成中: ${next}`);
        // A new top-level folder must not silently merge into an existing tree.
        const operation = await api.mutation(
          "/api/v1/nodes",
          "POST",
          {
            spaceId: account.spaceId,
            parentId: folders.get(path),
            name,
            kind: "folder",
          },
          crypto.randomUUID(),
        );
        if (!operation.result?.nodeId)
          throw new Error("フォルダーの作成結果を確認できません。一覧を更新してください。");
        folders.set(next, operation.result.nodeId);
      }
      path = next;
    }
    if (entry.file) {
      // Bound encrypted staging and upload records while accepting arbitrary folder sizes.
      await uploads.waitForCapacity(signal);
      await uploads.enqueue(entry.file, account, folders.get(path)!, undefined, signal);
      progress(`${++count} ファイルをアップロードに追加しました`);
    }
  }
}
