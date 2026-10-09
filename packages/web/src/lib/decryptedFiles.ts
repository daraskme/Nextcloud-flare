import { useEffect, useState, useSyncExternalStore } from "react";
import { type Account, api, type FileNode, type PreparedContentSession } from "./api";
import { readEncryptedContent } from "./encryptedContent";
import {
  type EncryptionSession,
  getEncryptionSession,
  isEncryptedFile,
  subscribeEncryptionSession,
} from "./encryptionSession";

const metadata = new WeakMap<
  EncryptionSession,
  Map<string, Promise<Pick<FileNode, "name" | "size" | "mime">>>
>();

export async function displayFile(
  account: Account,
  node: FileNode,
  metadataSession?: PreparedContentSession,
): Promise<FileNode> {
  const session = getEncryptionSession(account.id);
  if (!session || !isEncryptedFile(node)) return node;
  let entries = metadata.get(session);
  if (!entries) metadata.set(session, (entries = new Map()));
  const key = `${node.id}:${node.currentBlobId}:${node.revision}`;
  let pending = entries.get(key);
  if (!pending) {
    pending = (async () => {
      const content = await readEncryptedContent(
        account,
        node,
        undefined,
        undefined,
        metadataSession,
      );
      try {
        return {
          name: content.opened.metadata.name,
          mime: content.opened.metadata.mime,
          size: content.opened.envelope.plainSize,
        };
      } finally {
        await content.close();
      }
    })();
    entries.set(key, pending);
    void pending.catch(() => entries!.delete(key));
  }
  const visible = await pending;
  return getEncryptionSession(account.id) === session ? { ...node, ...visible } : node;
}

/** Share one content grant across a listing batch instead of exchanging one cookie per file. */
export async function displayFiles(account: Account, nodes: FileNode[]): Promise<FileNode[]> {
  const keys = getEncryptionSession(account.id);
  if (!keys) return nodes;
  const result: FileNode[] = [];
  for (let offset = 0; offset < nodes.length; offset += 20) {
    if (getEncryptionSession(account.id) !== keys) return nodes;
    const batch = nodes.slice(offset, offset + 20);
    const missing = batch.filter(
      (node) =>
        isEncryptedFile(node) &&
        node.currentBlobId &&
        !metadata.get(keys)?.has(`${node.id}:${node.currentBlobId}:${node.revision}`),
    );
    let content: PreparedContentSession | undefined;
    try {
      if (missing.length)
        content = await api.prepareContentSession(
          account,
          missing.map((node) => ({ id: node.id, currentBlobId: node.currentBlobId! })),
          "content",
        );
      for (const node of batch) {
        try {
          result.push(await displayFile(account, node, content));
        } catch {
          result.push(node);
        }
      }
    } finally {
      await content?.cancel().catch(() => undefined);
    }
  }
  return getEncryptionSession(account.id) === keys ? result : nodes;
}

export function useDisplayFiles(account: Account | undefined, nodes: FileNode[]) {
  const session = useSyncExternalStore(subscribeEncryptionSession, () =>
    account ? getEncryptionSession(account.id) : null,
  );
  const [resolved, setResolved] = useState<{
    session: EncryptionSession;
    files: Map<string, FileNode>;
  } | null>(null);
  const signature = nodes
    .map((node) => `${node.id}:${node.revision}:${node.currentBlobId}`)
    .join(",");
  useEffect(() => {
    if (!account || !session) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const files = new Map<string, FileNode>();
      for (let offset = 0; offset < nodes.length; offset += 20) {
        if (cancelled) return;
        try {
          for (const node of await displayFiles(account, nodes.slice(offset, offset + 20)))
            files.set(node.id, node);
        } catch {
          /* Keep locked name when the key cannot decrypt this file. */
        }
        if (!cancelled) setResolved({ session, files: new Map(files) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account?.id, account?.epoch, session, signature]);
  return nodes.map((node) => {
    const visible = resolved?.session === session ? resolved.files.get(node.id) : undefined;
    return visible?.currentBlobId === node.currentBlobId && visible.revision === node.revision
      ? { ...node, name: visible.name, size: visible.size, mime: visible.mime }
      : node;
  });
}

export function isTextFile(node: Pick<FileNode, "name" | "mime">) {
  return /\.(txt|text)$/i.test(node.name) || node.mime?.split(";")[0] === "text/plain";
}
