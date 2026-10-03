import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { type Account, api, type FileNode, formatBytes } from "../../lib/api";
import { saveClientMedia } from "../../lib/clientMediaRegistration";
import { type OpenEncryptedContent, readEncryptedContent } from "../../lib/encryptedContent";
import {
  getEncryptionSession,
  isEncryptedFile,
  setEncryptionSession,
  subscribeEncryptionSession,
} from "../../lib/encryptionSession";
import { uploads } from "../uploads/manager";
import { EncryptionSettings } from "./EncryptionSettings";

const INLINE =
  /^(?:image\/(?:avif|gif|jpeg|png|webp)|audio\/(?:mp4|mpeg|ogg|webm|wav)|video\/(?:mp4|ogg|webm))$/;

/** An explicit client-decrypted view; ciphertext never enters the legacy media parsers. */
export function EncryptedFiles({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const keys = useSyncExternalStore(subscribeEncryptionSession, () =>
    getEncryptionSession(account.id),
  );
  const [ownerId, setOwnerId] = useState(account.id);
  const [folderId, setFolderId] = useState(account.rootNodeId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [active, setActive] = useState<{ content: OpenEncryptedContent; url: string } | null>(null);
  const activeRef = useRef<OpenEncryptedContent | null>(null);
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const ownerList = useInfiniteQuery({
    queryKey: ["encryption-owners", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.adminUsers(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: account.role === "app_admin",
  });
  const owners = ownerList.data?.pages.flatMap((page) => page.users) ?? [];
  const owner = ownerId === account.id ? undefined : owners.find((item) => item.id === ownerId);
  const children = useInfiniteQuery({
    queryKey: ["encrypted-children", account.id, account.epoch, ownerId, folderId],
    queryFn: ({ pageParam, signal }) =>
      owner
        ? api.adminChildren(owner.id, folderId, pageParam, signal)
        : api.children(folderId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!keys && (ownerId === account.id || !!owner),
  });
  const path = useQuery({
    queryKey: ["encrypted-path", account.id, ownerId, folderId],
    queryFn: ({ signal }) =>
      owner ? api.adminPath(owner.id, folderId, signal) : api.path(folderId, signal),
    enabled: !!keys && (ownerId === account.id || !!owner),
  });
  const rows = children.data?.pages.flatMap((page) => page.children) ?? [];
  const close = () => {
    generation.current++;
    if (activeRef.current) void activeRef.current.close();
    activeRef.current = null;
    setActive(null);
  };
  useEffect(() => {
    close();
  }, [keys, ownerId, folderId]);
  useEffect(
    () => () => {
      generation.current++;
      void activeRef.current?.close();
    },
    [],
  );
  const report = (error: unknown) =>
    setNotice(
      error instanceof Error && /[\u3000-\u9fff]/.test(error.message)
        ? error.message
        : "処理できませんでした。鍵の解除、接続、ファイルの状態を確認して再度開いてください。",
    );
  const open = async (node: FileNode) => {
    close();
    const selected = generation.current;
    setBusy(true);
    setNotice("");
    try {
      const content = await readEncryptedContent(account, node, owner);
      if (selected !== generation.current) {
        await content.close();
        return;
      }
      activeRef.current = content;
      const url = INLINE.test(content.opened.metadata.mime) ? await content.media("inline") : "";
      if (selected !== generation.current) {
        await content.close();
        return;
      }
      setActive({ content, url });
    } catch (error) {
      close();
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const content = active?.content;
    if (!content) return;
    setBusy(true);
    setNotice("");
    try {
      // Must be invoked while the browser still has the button's user activation.
      const picker = (
        window as Window & {
          showSaveFilePicker?: (options: {
            suggestedName: string;
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker;
      if (picker) {
        const handle = await picker({ suggestedName: content.opened.metadata.name });
        const destination = await handle.createWritable();
        await saveClientMedia(await content.media("download"), content.opened.envelope.plainSize, {
          write: (bytes) => destination.write(new Uint8Array(bytes)),
          close: () => destination.close(),
          abort: (reason) => destination.abort(reason),
        });
      } else {
        if (content.opened.envelope.plainSize > 64 * 1024 * 1024)
          throw new Error(
            "64 MiBを超える復号保存には、保存先を選択できるChromeなどを利用してください。",
          );
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        await saveClientMedia(await content.media("download"), content.opened.envelope.plainSize, {
          async write(bytes) {
            chunks.push(new Uint8Array(bytes));
          },
          async close() {},
          async abort() {
            chunks.length = 0;
          },
        });
        const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = content.opened.metadata.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setNotice("復号したファイルを保存しました。");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) report(error);
    } finally {
      setBusy(false);
    }
  };
  const add = async (files: FileList | null) => {
    if (!files || !keys?.adminRecipient || ownerId !== account.id) return;
    setBusy(true);
    setNotice("");
    try {
      for (const file of files) await uploads.enqueue(file, account, folderId);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const migrateCopy = async (node: FileNode) => {
    if (!keys?.adminRecipient || owner || !node.currentBlobId) return;
    if (node.size === null || node.size > 128 * 1024 * 1024) {
      setNotice(
        "128 MiBを超える既存ファイルは、端末にダウンロードしてから暗号化アップロードしてください。",
      );
      return;
    }
    setBusy(true);
    setNotice("");
    let content;
    try {
      content = await api.prepareContentSession(
        account,
        [{ id: node.id, currentBlobId: node.currentBlobId }],
        "content",
      );
      const response = await fetch(
        content.url({ id: node.id, currentBlobId: node.currentBlobId }),
        {
          credentials: "include",
          cache: "no-store",
          redirect: "error",
        },
      );
      if (
        response.status !== 200 ||
        response.headers.get("Content-Length") !== String(node.size) ||
        !response.body
      )
        throw new Error("migration_read_failed");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > node.size) throw new Error("migration_overflow");
          chunks.push(new Uint8Array(next.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (bytes !== node.size || getEncryptionSession(account.id) !== keys)
        throw new Error("migration_invalid");
      await uploads.enqueue(
        new File(chunks, node.name, {
          type: node.mime ?? "application/octet-stream",
          lastModified: node.updatedAt,
        }),
        account,
        folderId,
      );
      setNotice(
        "暗号化コピーの送信を開始しました。元の平文ファイルと過去のバックアップは残っています。復号を確認してから整理してください。",
      );
    } catch (error) {
      report(error);
    } finally {
      await content?.cancel().catch(() => undefined);
      setBusy(false);
    }
  };
  return (
    <section className="encryption-files" aria-label="暗号化ファイル">
      <EncryptionSettings
        account={account}
        initialUnlocked={keys}
        onUnlocked={(value) =>
          setEncryptionSession(
            account.id,
            value ? { owner: value.owner, adminRecipient: value.adminRecipient } : null,
          )
        }
      />
      <p className="encryption-note">
        設定済みのこのブラウザーでは、新規アップロードを本人と管理者の鍵で暗号化します。鍵は再読み込み時にロックされます。既存の平文ファイル・WebDAV・公開共有は自動では暗号化されません。
      </p>
      <p className="encryption-note">
        フォルダー名・サイズ・アクセス記録はCloudflareに見えます。配信されるアプリの改変や、サービスの停止・削除を防ぐ機能ではありません。
      </p>
      {notice && <p role="status">{notice}</p>}
      {keys && (
        <>
          {!keys.adminRecipient && (
            <p role="status">
              本人の鍵で既存ファイルを復号できます。新規アップロードには管理者公開鍵の固定が必要です。
            </p>
          )}
          {account.role === "app_admin" && (
            <label>
              暗号化ファイルの所有者{" "}
              <select
                aria-label="暗号化ファイルの所有者"
                value={ownerId}
                onChange={(event) => {
                  const id = event.target.value;
                  setOwnerId(id);
                  setFolderId(
                    id === account.id
                      ? account.rootNodeId
                      : owners.find((item) => item.id === id)!.rootNodeId,
                  );
                }}
              >
                <option value={account.id}>自分のファイル</option>
                {owners
                  .filter((item) => item.id !== account.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.email}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {ownerList.hasNextPage && (
            <Button onClick={() => void ownerList.fetchNextPage()}>利用者をさらに表示</Button>
          )}
          {owner && <p>管理者として読み取り専用で閲覧しています。閲覧履歴を記録します。</p>}
          <nav aria-label="暗号化フォルダー階層">
            {path.data?.path.map((item) => (
              <Button key={item.id} variant="ghost" onClick={() => setFolderId(item.id)}>
                {item.name}
              </Button>
            ))}
          </nav>
          <div className="encryption-toolbar">
            {!owner && (
              <Button
                disabled={busy || !keys.adminRecipient}
                onClick={() => input.current?.click()}
              >
                暗号化してアップロード
              </Button>
            )}
            <Button
              onClick={() =>
                void queryClient.invalidateQueries({ queryKey: ["encrypted-children"] })
              }
            >
              一覧を更新
            </Button>
            <input
              ref={input}
              hidden
              type="file"
              multiple
              aria-label="暗号化するファイル"
              onChange={(event) => void add(event.target.files)}
            />
          </div>
          {children.error || path.error ? (
            <p role="alert">一覧を取得できません。再度読み込んでください。</p>
          ) : null}
          <ul className="encryption-list">
            {rows.map((node) => (
              <li key={node.id}>
                <span>
                  {node.kind === "folder"
                    ? node.name
                    : isEncryptedFile(node.name)
                      ? `暗号化ファイル · ${node.name.slice(0, 8)}`
                      : node.name}{" "}
                  {node.size !== null && formatBytes(node.size)}
                </span>
                {node.kind === "folder" ? (
                  <Button variant="ghost" onClick={() => setFolderId(node.id)}>
                    フォルダーを開く
                  </Button>
                ) : isEncryptedFile(node.name) ? (
                  <Button disabled={busy} onClick={() => void open(node)}>
                    復号して開く
                  </Button>
                ) : (
                  <span>
                    未暗号化{" "}
                    {!owner && (
                      <Button
                        disabled={busy || !keys.adminRecipient}
                        variant="ghost"
                        onClick={() => void migrateCopy(node)}
                      >
                        暗号化コピーを作成
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {children.hasNextPage && (
            <Button onClick={() => void children.fetchNextPage()}>次の項目を表示</Button>
          )}
          {active && (
            <section className="encryption-preview" aria-label="復号プレビュー">
              <h3>{active.content.opened.metadata.name}</h3>
              <p>{formatBytes(active.content.opened.envelope.plainSize)} · 端末内で復号</p>
              {active.url &&
                (active.content.opened.metadata.mime.startsWith("video/") ? (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={active.url}
                    onError={() =>
                      setNotice(
                        "動画を読み込めません。セッションの期限切れや再生形式を確認し、もう一度「復号して開く」を押してください。",
                      )
                    }
                  />
                ) : active.content.opened.metadata.mime.startsWith("audio/") ? (
                  <audio
                    controls
                    preload="metadata"
                    src={active.url}
                    onError={() =>
                      setNotice("音声を読み込めません。もう一度ファイルを開いてください。")
                    }
                  />
                ) : (
                  <img src={active.url} alt={active.content.opened.metadata.name} />
                ))}
              {!active.url && <p>この形式は復号して端末に保存できます。</p>}
              <Button disabled={busy} onClick={() => void download()}>
                復号して保存
              </Button>{" "}
              <Button variant="ghost" onClick={close}>
                閉じる
              </Button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
