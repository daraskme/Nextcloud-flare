import {
  type Account,
  type AdminFileUser,
  api,
  type FileNode,
  type PreparedContentSession,
} from "./api";
import {
  registerClientMedia,
  renewClientMedia,
  revokeClientMedia,
} from "./clientMediaRegistration";
import {
  type OpenedContainer,
  openContainerHeader,
  parseContainerHeader,
  readContainerHeaderLength,
} from "./encryptedContainer";
import { getEncryptionSession, onEncryptionLock } from "./encryptionSession";

export interface OpenEncryptedContent {
  readonly opened: OpenedContainer;
  media(mode: "inline" | "download"): Promise<string>;
  close(): Promise<void>;
}

/** Read bounded ciphertext ranges only. Never accept a server's whole-file fallback. */
export async function readEncryptedContent(
  account: Account,
  node: FileNode,
  owner?: AdminFileUser,
  signal?: AbortSignal,
): Promise<OpenEncryptedContent> {
  const keys = getEncryptionSession(account.id);
  if (!keys || !node.currentBlobId || !Number.isSafeInteger(node.size) || node.size! < 12)
    throw new Error("暗号化設定で復旧ファイルを読み込み、鍵を解除してください。");
  const controller = new AbortController();
  const signals = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  let action: "preview" | "download" = "preview";
  const content = owner
    ? await api.prepareAdminContentSession(owner, node, action, account, signals)
    : await api.prepareContentSession(
        account,
        [{ id: node.id, currentBlobId: node.currentBlobId }],
        "content",
        signals,
      );
  const url = content.url({ id: node.id, currentBlobId: node.currentBlobId });
  const virtual = new Map<"inline" | "download", string>();
  let closed = false;
  let expiresAt = Date.now() + 270_000;
  const sessions: { session: PreparedContentSession; at: number }[] = [
    { session: content, at: Date.now() },
  ];
  let renewal: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let detach = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(renewal);
    controller.abort();
    detach();
    await Promise.allSettled([...virtual.values()].map(revokeClientMedia));
    await Promise.allSettled(sessions.map(({ session }) => session.cancel()));
  };
  detach = onEncryptionLock(() => {
    void close();
  });
  try {
    let etag = "";
    const range = async (offset: number, length: number) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: signals,
      });
      const receivedEtag = response.headers.get("ETag") ?? "";
      if (
        response.status !== 206 ||
        response.url !== url ||
        response.redirected ||
        !/^"[A-Za-z0-9._:-]{1,200}"$/.test(receivedEtag) ||
        (etag && receivedEtag !== etag) ||
        response.headers.get("Content-Range") !==
          `bytes ${offset}-${offset + length - 1}/${node.size}` ||
        (response.headers.has("Content-Length") &&
          response.headers.get("Content-Length") !== String(length)) ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error("暗号化ファイルの配信情報を確認できません。再度開いてください。");
      }
      etag = receivedEtag;
      const bytes = new Uint8Array(length);
      const reader = response.body.getReader();
      let count = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (count + next.value.length > length) throw new Error("encrypted_range_overflow");
          bytes.set(next.value, count);
          count += next.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (count !== length) throw new Error("encrypted_range_truncated");
      return bytes;
    };
    const prefix = await range(0, 12);
    const length = readContainerHeaderLength(prefix);
    const headerBytes = new Uint8Array(12 + length);
    headerBytes.set(prefix);
    headerBytes.set(await range(12, length), 12);
    const header = parseContainerHeader(headerBytes);
    if (header.totalBytes !== node.size || `${header.envelope.cryptoId}.ncf` !== node.name)
      throw new Error("暗号化ファイルの名前またはサイズが一致しません。");
    const opened = await openContainerHeader(header, keys.owner);
    signals.throwIfAborted();
    if (getEncryptionSession(account.id) !== keys) throw new Error("encryption_locked");
    renewal = setInterval(() => {
      if (renewing || closed) return;
      renewing = true;
      void (async () => {
        if (getEncryptionSession(account.id) !== keys) throw new Error("encryption_locked");
        const next = owner
          ? await api.prepareAdminContentSession(owner, node, action, account, signals)
          : await api.prepareContentSession(
              account,
              [{ id: node.id, currentBlobId: node.currentBlobId! }],
              "content",
              signals,
            );
        if (closed) {
          await next.cancel();
          return;
        }
        sessions.push({ session: next, at: Date.now() });
        expiresAt = Date.now() + 270_000;
        for (const media of virtual.values()) await renewClientMedia(media, expiresAt);
        // Let old in-flight ranges finish before discarding naturally expired tickets.
        while (sessions[0] && sessions[0].at < Date.now() - 300_000) {
          const expired = sessions.shift()!;
          await expired.session.cancel().catch(() => undefined);
        }
      })()
        .catch(() => close())
        .finally(() => {
          renewing = false;
        });
    }, 180_000);
    return {
      opened,
      close,
      async media(mode) {
        signals.throwIfAborted();
        if (owner && mode === "download") {
          const download = await api.prepareAdminContentSession(
            owner,
            node,
            "download",
            account,
            signals,
          );
          if (closed) {
            await download.cancel();
            throw new Error("encryption_locked");
          }
          sessions.push({ session: download, at: Date.now() });
          action = "download";
          expiresAt = Date.now() + 270_000;
        }
        const existing = virtual.get(mode);
        if (existing) {
          await renewClientMedia(existing, expiresAt);
          return existing;
        }
        const value = await registerClientMedia({
          headerBytes,
          cipher: opened.cipher,
          sourceUrl: url,
          sourceEtag: etag,
          accountId: account.id,
          expiresAt,
          mode,
        });
        if (closed) {
          await revokeClientMedia(value);
          throw new Error("encryption_locked");
        }
        virtual.set(mode, value);
        return value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
