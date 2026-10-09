import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, api, errorMessage, type FileNode } from "../../lib/api";
import { isTextFile } from "../../lib/decryptedFiles";
import { downloadDecrypted } from "../../lib/downloadDecrypted";
import { readEncryptedContent } from "../../lib/encryptedContent";
import { isEncryptedFile, onEncryptionLock } from "../../lib/encryptionSession";
import { TextReader } from "../library/TextReader";

const MAX_TEXT_BYTES = 32 * 1024 * 1024;
export async function readText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("本文を読み込めませんでした。");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_TEXT_BYTES)
        throw new Error("小説リーダーは32 MBまでのテキストに対応しています。");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export function FilePreview({
  account,
  node,
  close,
}: {
  account: Account;
  node: FileNode;
  close: () => void;
}) {
  const [preview, setPreview] = useState<{
    name: string;
    mime: string;
    url: string;
    download: string;
    size: number;
    text?: string;
  } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let release = async () => {};
    const detach = onEncryptionLock(() => {
      setPreview(null);
      close();
    });
    void (async () => {
      let name = node.name,
        mime = node.mime ?? "application/octet-stream",
        size = node.size ?? 0;
      let url: string, download: string;
      if (isEncryptedFile(node)) {
        const content = await readEncryptedContent(account, node, undefined, controller.signal);
        release = content.close;
        name = content.opened.metadata.name;
        mime = content.opened.metadata.mime;
        size = content.opened.envelope.plainSize;
        url = await content.media("inline");
        download = await content.media("download");
      } else {
        if (!node.currentBlobId) throw new Error("ファイルを確認できません。");
        const target = { id: node.id, currentBlobId: node.currentBlobId };
        const content = await api.prepareContentSession(
          account,
          [target],
          "content",
          controller.signal,
        );
        release = content.cancel;
        url = content.url(target);
        download = url;
      }
      controller.signal.throwIfAborted();
      let text: string | undefined;
      if (isTextFile({ name, mime })) {
        if (size > MAX_TEXT_BYTES)
          throw new Error("小説リーダーは32 MBまでのテキストに対応しています。");
        text = await readText(
          await fetch(url, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          }),
        );
      }
      controller.signal.throwIfAborted();
      setPreview({ name, mime, url, download, size, ...(text !== undefined ? { text } : {}) });
      void api.recordRecent(node.id).catch(() => undefined);
    })().catch((error) => {
      void release();
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error && /[\u3000-\u9fff]/.test(error.message)
            ? error.message
            : errorMessage(error),
        );
    });
    return () => {
      controller.abort();
      detach();
      void release();
    };
  }, [account.id, account.epoch, node.id, node.currentBlobId]);
  return (
    <Dialog
      open
      title={preview?.name ?? "ファイルを開く"}
      description="内容を表示します。"
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <div className="file-preview">
        {failure ? (
          <p role="alert">{failure}</p>
        ) : !preview ? (
          <p role="status">読み込んでいます…</p>
        ) : (
          <>
            {preview.text !== undefined ? (
              <TextReader
                text={preview.text}
                storageKey={`ncf-novel:${account.id}:${node.id}:${node.currentBlobId}`}
              />
            ) : preview.mime.startsWith("image/") ? (
              <img src={preview.url} alt={preview.name} />
            ) : preview.mime.startsWith("audio/") ? (
              <audio src={preview.url} controls />
            ) : preview.mime.startsWith("video/") ? (
              <video src={preview.url} controls />
            ) : (
              <p>この形式はダウンロードして開けます。</p>
            )}
            {isEncryptedFile(node) ? (
              <Button
                onClick={() =>
                  void downloadDecrypted(preview.download, preview.name, preview.size).catch(
                    (error) =>
                      setFailure(error instanceof Error ? error.message : errorMessage(error)),
                  )
                }
              >
                ダウンロード
              </Button>
            ) : (
              <a className="button" href={preview.download} download={preview.name}>
                ダウンロード
              </a>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
