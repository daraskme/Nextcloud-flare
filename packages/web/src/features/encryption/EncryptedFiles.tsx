import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  encryptionHeaderHash,
  legacyAdoptionPayload,
} from "../../../../shared/src/encryptionAttestation";
import { Button } from "../../components/ui/button";
import { type Account, api, type FileNode, formatBytes } from "../../lib/api";
import { saveClientMedia } from "../../lib/clientMediaRegistration";
import {
  decryptContainerPlainRange,
  openContainerHeader,
  parseContainerHeader,
  readContainerHeaderLength,
} from "../../lib/encryptedContainer";
import { type OpenEncryptedContent, readEncryptedContent } from "../../lib/encryptedContent";
import {
  getEncryptionSession,
  isEncryptedFile,
  onEncryptionLock,
  setEncryptionSession,
  subscribeEncryptionSession,
} from "../../lib/encryptionSession";
import { uploads } from "../uploads/manager";
import { EncryptionSettings } from "./EncryptionSettings";

const INLINE =
  /^(?:image\/(?:avif|gif|jpeg|png|webp)|audio\/(?:mp4|mpeg|ogg|webm|wav)|video\/(?:mp4|ogg|webm))$/;

interface LegacyReview {
  readonly node: FileNode;
  readonly name: string;
  readonly mime: string;
  readonly url: string;
  readonly headerSha256: string;
  readonly cryptoId: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

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
  const [legacyReview, setLegacyReview] = useState<LegacyReview | null>(null);
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const activeRef = useRef<OpenEncryptedContent | null>(null);
  const legacyUrlRef = useRef<string | null>(null);
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
  const canWriteEncrypted = Boolean(
    keys?.ownerRegistered && keys.adminRecipient && keys.adminSigner,
  );
  const releasePreview = () => {
    generation.current++;
    if (activeRef.current) void activeRef.current.close();
    activeRef.current = null;
    if (legacyUrlRef.current) URL.revokeObjectURL(legacyUrlRef.current);
    legacyUrlRef.current = null;
  };
  const close = () => {
    releasePreview();
    setBusy(false);
    setActive(null);
    setLegacyReview(null);
    setLegacyConfirmed(false);
  };
  const selectFolder = (id: string) => {
    close();
    setFolderId(id);
  };
  useEffect(() => {
    close();
  }, [keys, ownerId, folderId]);
  useEffect(() => {
    const unsubscribe = onEncryptionLock(close);
    return () => {
      unsubscribe();
      releasePreview();
    };
  }, []);
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
  const inspectLegacy = async (node: FileNode) => {
    if (
      !keys?.ownerRegistered ||
      !keys.adminRecipient ||
      !keys.adminSigner ||
      ownerId !== account.id ||
      !node.currentBlobId
    ) {
      setNotice("旧形式を確認するには、本人と現在の管理者の鍵を登録・固定してください。");
      return;
    }
    if (node.size === null || node.size > 128 * 1024 * 1024) {
      setNotice("128 MiBを超える旧形式は、この画面で安全に確認できません。");
      return;
    }
    close();
    const selected = generation.current;
    setBusy(true);
    setNotice("");
    let content;
    const plaintext: Uint8Array<ArrayBuffer>[] = [];
    try {
      content = await api.prepareContentSession(
        account,
        [{ id: node.id, currentBlobId: node.currentBlobId }],
        "content",
      );
      const url = content.url({ id: node.id, currentBlobId: node.currentBlobId });
      let etag = "";
      const fetchRange = async (offset: number, length: number) => {
        const response = await fetch(url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          credentials: "include",
          cache: "no-store",
          redirect: "error",
        });
        const responseEtag = response.headers.get("ETag") ?? "";
        if (
          response.status !== 206 ||
          response.url !== url ||
          response.redirected ||
          !/^"[A-Za-z0-9._:-]{1,200}"$/.test(responseEtag) ||
          (etag && responseEtag !== etag) ||
          response.headers.get("Content-Range") !==
            `bytes ${offset}-${offset + length - 1}/${node.size}` ||
          (response.headers.has("Content-Length") &&
            response.headers.get("Content-Length") !== String(length)) ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new Error("旧形式ファイルの配信情報を確認できません。");
        }
        etag = responseEtag;
        const bytes = new Uint8Array(length);
        const reader = response.body.getReader();
        let count = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if (count + part.value.length > length) throw new Error("legacy_range_overflow");
            bytes.set(part.value, count);
            count += part.value.length;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (count !== length) throw new Error("legacy_range_truncated");
        return bytes;
      };
      const prefix = await fetchRange(0, 12);
      const headerLength = readContainerHeaderLength(prefix);
      const headerBytes = new Uint8Array(12 + headerLength);
      headerBytes.set(prefix);
      headerBytes.set(await fetchRange(12, headerLength), 12);
      const header = parseContainerHeader(headerBytes);
      if (
        header.signed ||
        header.totalBytes !== node.size ||
        !header.envelope.recipients.some(
          (entry) => entry.fingerprint === keys.owner.publicKey.fingerprint,
        ) ||
        !header.envelope.recipients.some(
          (entry) => entry.fingerprint === keys.adminRecipient!.fingerprint,
        )
      )
        throw new Error("このファイルは所有者と管理者の鍵で開ける旧形式ではありません。");
      const opened = await openContainerHeader(header, keys.owner, { legacyUnsigned: true });
      const readCipher = async (offset: number, length: number) => {
        const output = new Uint8Array(length);
        let received = 0;
        while (received < length) {
          const part = Math.min(4 * 1024 * 1024, length - received);
          // decryptContainerPlainRange already includes the container header in its offsets.
          output.set(await fetchRange(offset + received, part), received);
          received += part;
        }
        return output;
      };
      let totalPlain = 0;
      for await (const plain of decryptContainerPlainRange(
        opened,
        0,
        opened.envelope.plainSize,
        (chunk) => readCipher(chunk.cipherOffset, chunk.cipherLength),
      )) {
        try {
          totalPlain += plain.length;
          if (totalPlain > 128 * 1024 * 1024) throw new Error("legacy_plaintext_overflow");
          plaintext.push(new Uint8Array(plain));
        } finally {
          plain.fill(0);
        }
      }
      if (selected !== generation.current || getEncryptionSession(account.id) !== keys)
        throw new Error("暗号化鍵または選択中のファイルが変更されました。");
      const blob = new Blob(plaintext, { type: opened.metadata.mime });
      for (const part of plaintext) part.fill(0);
      plaintext.length = 0;
      const headerSha256 = await encryptionHeaderHash(new Uint8Array(headerBytes));
      if (selected !== generation.current || getEncryptionSession(account.id) !== keys) return;
      const previewUrl = URL.createObjectURL(blob);
      legacyUrlRef.current = previewUrl;
      setLegacyReview({
        node,
        name: opened.metadata.name,
        mime: opened.metadata.mime,
        url: previewUrl,
        headerSha256,
        cryptoId: header.envelope.cryptoId,
      });
      setLegacyConfirmed(false);
    } catch (error) {
      if (selected === generation.current) {
        close();
        report(error);
      }
    } finally {
      for (const part of plaintext) part.fill(0);
      plaintext.length = 0;
      await content?.cancel().catch(() => undefined);
      if (selected === generation.current) setBusy(false);
    }
  };
  const adoptLegacy = async () => {
    const candidate = legacyReview;
    const keys = getEncryptionSession(account.id);
    if (!candidate || !legacyConfirmed || !keys?.ownerRegistered || !keys.adminRecipient) return;
    setBusy(true);
    setNotice("");
    try {
      const { node } = candidate;
      const current = await api.request<FileNode & { ownerId: string }>(
        `/api/v1/nodes/${encodeURIComponent(node.id)}`,
      );
      if (
        current.id !== node.id ||
        current.ownerId !== account.id ||
        current.revision !== node.revision ||
        current.currentBlobId !== node.currentBlobId ||
        current.encryption
      )
        throw new Error("元のファイルが変更されました。一覧を更新して確認し直してください。");
      const payload = legacyAdoptionPayload({
        ownerId: account.id,
        nodeId: node.id,
        blobId: node.currentBlobId!,
        revision: node.revision,
        headerSha256: candidate.headerSha256,
        cryptoId: candidate.cryptoId,
        requiredAdminFingerprint: keys.adminRecipient.fingerprint,
      });
      const signature = encodeBase64Url(
        new Uint8Array(await crypto.subtle.sign("Ed25519", keys.owner.signing.privateKey, payload)),
      );
      await api.adoptLegacyEncryptedNode(node.id, {
        blobId: node.currentBlobId!,
        revision: node.revision,
        headerSha256: candidate.headerSha256,
        ownerSignature: signature,
        requiredAdminFingerprint: keys.adminRecipient.fingerprint,
      });
      close();
      setNotice(
        "現在の内容を旧形式として明示的に確認し、所有者署名を登録しました。過去の送信者は証明されません。",
      );
      void queryClient.invalidateQueries({ queryKey: ["encrypted-children"] });
    } catch (error) {
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
    if (!files || !canWriteEncrypted || ownerId !== account.id) return;
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
    if (!canWriteEncrypted || owner || !node.currentBlobId) return;
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
      const declaredLength = response.headers.get("Content-Length");
      if (
        response.status !== 200 ||
        (declaredLength !== null && declaredLength !== String(node.size)) ||
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
      const current = await api.request<
        FileNode & { spaceId: string; ownerId: string; parentId: string }
      >(`/api/v1/nodes/${encodeURIComponent(node.id)}`);
      if (
        current.id !== node.id ||
        current.kind !== "file" ||
        current.spaceId !== account.spaceId ||
        current.ownerId !== account.id ||
        current.parentId !== folderId ||
        current.name !== node.name ||
        current.revision !== node.revision ||
        current.currentBlobId !== node.currentBlobId ||
        getEncryptionSession(account.id) !== keys
      )
        throw new Error("元のファイルが変更されました。一覧を更新して再確認してください。");
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
            value
              ? {
                  owner: value.owner,
                  ownerRegistered: value.ownerRegistered,
                  adminRecipient: value.adminRecipient,
                  adminSigner: value.adminSigner,
                }
              : null,
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
          {!canWriteEncrypted && (
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
                  close();
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
              <Button key={item.id} variant="ghost" onClick={() => selectFolder(item.id)}>
                {item.name}
              </Button>
            ))}
          </nav>
          <div className="encryption-toolbar">
            {!owner && (
              <Button disabled={busy || !canWriteEncrypted} onClick={() => input.current?.click()}>
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
                    : isEncryptedFile(node)
                      ? `暗号化ファイル · ${node.name.slice(0, 8)}`
                      : node.name}{" "}
                  {node.size !== null && formatBytes(node.size)}
                </span>
                {node.kind === "folder" ? (
                  <Button variant="ghost" onClick={() => selectFolder(node.id)}>
                    フォルダーを開く
                  </Button>
                ) : isEncryptedFile(node) ? (
                  <Button disabled={busy} onClick={() => void open(node)}>
                    復号して開く
                  </Button>
                ) : (
                  <span>
                    未暗号化{" "}
                    {!owner && (
                      <>
                        <Button
                          disabled={busy || !canWriteEncrypted}
                          variant="ghost"
                          onClick={() => void migrateCopy(node)}
                        >
                          暗号化コピーを作成
                        </Button>
                        <Button
                          disabled={busy || !canWriteEncrypted || node.size === null}
                          variant="ghost"
                          onClick={() => void inspectLegacy(node)}
                        >
                          旧形式を確認
                        </Button>
                      </>
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
      {legacyReview && (
        <section
          className="encryption-preview"
          role="dialog"
          aria-modal="true"
          aria-label="旧形式ファイルの確認"
        >
          <header>
            <h2>旧形式の内容確認: {legacyReview.name}</h2>
            <Button variant="ghost" onClick={close}>
              閉じる
            </Button>
          </header>
          <p>
            旧形式には送信者署名がありません。復号できたことだけでは過去の送信者を証明できません。以下の内容を確認してから、このファイル固有の現在の署名を登録してください。
          </p>
          {legacyReview.mime.startsWith("image/") ? (
            <img src={legacyReview.url} alt={legacyReview.name} />
          ) : legacyReview.mime.startsWith("audio/") ? (
            <audio
              controls
              preload="metadata"
              src={legacyReview.url}
              aria-label={legacyReview.name}
            />
          ) : legacyReview.mime.startsWith("video/") ? (
            <video
              controls
              preload="metadata"
              playsInline
              src={legacyReview.url}
              aria-label={legacyReview.name}
            />
          ) : (
            <a href={legacyReview.url} download={legacyReview.name}>
              復号した内容を保存して確認
            </a>
          )}
          <label>
            <input
              type="checkbox"
              checked={legacyConfirmed}
              onChange={(event) => setLegacyConfirmed(event.currentTarget.checked)}
            />
            この内容を確認しました。過去の送信者は証明できないことを理解しています。
          </label>
          <Button disabled={busy || !legacyConfirmed} onClick={() => void adoptLegacy()}>
            この旧形式に所有者署名を登録
          </Button>
        </section>
      )}
    </section>
  );
}
