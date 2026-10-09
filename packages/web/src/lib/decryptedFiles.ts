import { useEffect, useState, useSyncExternalStore } from "react";
import { type Account, api, type FileNode, type PreparedContentSession } from "./api";
import { readEncryptedContent } from "./encryptedContent";
import { cachedFileMetadata } from "./encryptedMetadataCache";
import {
  type EncryptionSession,
  getEncryptionSession,
  isEncryptedFile,
  subscribeEncryptionSession,
} from "./encryptionSession";

type Metadata = Pick<FileNode, "name" | "size" | "mime">;
const metadata = new WeakMap<
  EncryptionSession,
  {
    pending: Map<string, Promise<Metadata>>;
    resolved: Map<string, Metadata>;
  }
>();
function entriesFor(session: EncryptionSession) {
  let entries = metadata.get(session);
  if (!entries) {
    entries = { pending: new Map(), resolved: new Map() };
    metadata.set(session, entries);
  }
  return entries;
}
const metadataKey = (node: FileNode) =>
  `${node.id}:${node.currentBlobId}:${node.revision}:${node.encryption?.headerSha256 ?? ""}`;

export async function displayFile(
  account: Account,
  node: FileNode,
  metadataSession?: PreparedContentSession,
): Promise<FileNode> {
  const session = getEncryptionSession(account.id);
  if (!session || !isEncryptedFile(node)) return node;
  const entries = entriesFor(session);
  const key = metadataKey(node);
  let pending = entries.pending.get(key);
  if (!pending) {
    pending = (async () => {
      if (!metadataSession) {
        const cached = await cachedFileMetadata(account, node);
        if (cached) return cached;
      }
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
    entries.pending.set(key, pending);
    void pending.then(
      (visible) => entries.resolved.set(key, visible),
      () => entries.pending.delete(key),
    );
  }
  const visible = await pending;
  return getEncryptionSession(account.id) === session ? { ...node, ...visible } : node;
}

/** Share one content grant across a listing batch instead of exchanging one cookie per file. */
export async function displayFiles(
  account: Account,
  nodes: FileNode[],
  onResolved?: (node: FileNode) => void,
): Promise<FileNode[]> {
  const keys = getEncryptionSession(account.id);
  if (!keys) return nodes;
  const entries = entriesFor(keys);
  const result: FileNode[] = [];
  for (let offset = 0; offset < nodes.length; offset += 20) {
    if (getEncryptionSession(account.id) !== keys) return nodes;
    const batch = nodes.slice(offset, offset + 20);
    // Cached signed headers can be opened locally before any content ticket or range request.
    await Promise.all(
      batch.map(async (node) => {
        const key = metadataKey(node);
        if (!isEncryptedFile(node) || entries.pending.has(key)) return;
        const cached = await cachedFileMetadata(account, node);
        if (!cached || getEncryptionSession(account.id) !== keys) return;
        entries.pending.set(key, Promise.resolve(cached));
        entries.resolved.set(key, cached);
        onResolved?.({ ...node, ...cached });
      }),
    );
    if (getEncryptionSession(account.id) !== keys) return nodes;
    const missing = batch.filter(
      (node) =>
        isEncryptedFile(node) && node.currentBlobId && !entries.pending.has(metadataKey(node)),
    );
    let content: PreparedContentSession | undefined;
    try {
      if (missing.length)
        content = await api.prepareContentSession(
          account,
          missing.map((node) => ({ id: node.id, currentBlobId: node.currentBlobId! })),
          "content",
        );
      // Limit uncached network reads, and publish each filename as soon as it resolves.
      for (let index = 0; index < batch.length; index += 4)
        result.push(
          ...(await Promise.all(
            batch.slice(index, index + 4).map(async (node) => {
              let visible = node;
              try {
                visible = await displayFile(account, node, content);
              } catch {
                // Keep the opaque source for callers; the file list supplies a readable placeholder.
              }
              if (getEncryptionSession(account.id) === keys) onResolved?.(visible);
              return visible;
            }),
          )),
        );
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
  const signature = nodes.map(metadataKey).join(",");
  useEffect(() => {
    if (!account || !session) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const files = new Map<string, FileNode>();
      const update = (node: FileNode) => {
        if (cancelled) return;
        files.set(node.id, node);
        setResolved({ session, files: new Map(files) });
      };
      for (let offset = 0; offset < nodes.length; offset += 20) {
        if (cancelled) return;
        try {
          for (const node of await displayFiles(account, nodes.slice(offset, offset + 20), update))
            files.set(node.id, node);
        } catch {
          for (const node of nodes.slice(offset, offset + 20)) update(node);
        }
        if (!cancelled) setResolved({ session, files: new Map(files) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account?.id, account?.epoch, session, signature]);
  return nodes.map((node) => {
    if (!isEncryptedFile(node)) return node;
    const visible = session ? metadata.get(session)?.resolved.get(metadataKey(node)) : undefined;
    if (visible) return { ...node, ...visible };
    const attempted = resolved?.session === session && resolved?.files.has(node.id);
    return {
      ...node,
      name: !session
        ? "暗号化ファイル"
        : attempted
          ? "ファイル名を確認できません"
          : "ファイル名を読み込んでいます…",
    };
  });
}

export function isTextFile(node: Pick<FileNode, "name" | "mime">) {
  return /\.(txt|text)$/i.test(node.name) || node.mime?.split(";")[0] === "text/plain";
}
