import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, FolderOpen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type Account,
  api,
  errorMessage,
  type FileNode,
  type PreparedContentSession,
} from "../../lib/api";
import { isEncryptedFile } from "../../lib/encryptionSession";

const dateTime = (value: number) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);

export function AllUserFiles({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const isAdmin = account.role === "app_admin";
  const [ownerId, setOwnerId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    ownerEmail: string;
    node: FileNode;
    mime: string;
    url: string;
    session: PreparedContentSession;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;
  const previewGeneration = useRef(0);
  const mounted = useRef(true);
  const users = useInfiniteQuery({
    queryKey: ["admin-file-users", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.adminUsers(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: isAdmin,
    retry: false,
  });
  const owners = users.data?.pages.flatMap((page) => page.users) ?? [];
  const owner = owners.find((user) => user.id === ownerId);
  useEffect(() => {
    if (!owner && owners[0]) setOwnerId(owners[0].id);
  }, [owner, owners]);
  useEffect(() => setFolderId(owner?.rootNodeId ?? ""), [owner?.id, owner?.rootNodeId]);

  const children = useInfiniteQuery({
    queryKey: ["admin-file-children", account.id, account.epoch, owner?.id, folderId],
    queryFn: ({ pageParam, signal }) => api.adminChildren(owner!.id, folderId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: isAdmin && !!owner && !!folderId,
    retry: false,
  });
  const path = useQuery({
    queryKey: ["admin-file-path", account.id, account.epoch, owner?.id, folderId],
    queryFn: ({ signal }) => api.adminPath(owner!.id, folderId, signal),
    enabled: isAdmin && !!owner && !!folderId,
    retry: false,
  });
  const audit = useInfiniteQuery({
    queryKey: ["admin-file-audit", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.adminAudit(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: isAdmin,
    retry: false,
  });
  const rows = useMemo(
    () => children.data?.pages.flatMap((page) => page.children) ?? [],
    [children.data],
  );
  const ownerById = useMemo(() => new Map(owners.map((user) => [user.id, user])), [owners]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewError(false);
  }, [ownerId]);
  useEffect(() => {
    return () => {
      if (preview) void preview.session.cancel().catch(() => undefined);
    };
  }, [preview]);
  useEffect(() => {
    if (children.dataUpdatedAt || path.dataUpdatedAt) {
      void queryClient.invalidateQueries({
        queryKey: ["admin-file-audit", account.id, account.epoch],
      });
    }
  }, [account.epoch, account.id, children.dataUpdatedAt, path.dataUpdatedAt, queryClient]);

  if (!isAdmin)
    return (
      <section className="admin-files-denied" role="status">
        <h2>この画面を利用できません</h2>
        <p>全利用者のファイルを閲覧できるのは管理者だけです。</p>
      </section>
    );

  const openContent = async (node: FileNode, action: "preview" | "download") => {
    const selectedOwner = owner;
    if (!selectedOwner || !node.currentBlobId) return;
    const requestGeneration = ++previewGeneration.current;
    const inlineMedia =
      action === "preview" &&
      (node.mime?.startsWith("audio/") || node.mime === "video/mp4" || node.mime === "video/webm");
    const target = inlineMedia ? null : window.open("about:blank", "_blank");
    if (!inlineMedia && !target) {
      setNotice("新しいタブを開けませんでした。ポップアップを許可してください。");
      return;
    }
    if (target) target.opener = null;
    try {
      const session = await api.prepareAdminContentSession(selectedOwner, node, action, account);
      if (
        !mounted.current ||
        requestGeneration !== previewGeneration.current ||
        ownerIdRef.current !== selectedOwner.id
      ) {
        await session.cancel().catch(() => undefined);
        target?.close();
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["admin-file-audit", account.id, account.epoch],
      });
      const url = session.url({ id: node.id, currentBlobId: node.currentBlobId });
      if (inlineMedia) {
        setPreview({
          name: node.name,
          ownerEmail: selectedOwner.email,
          node,
          mime: node.mime ?? "",
          url,
          session,
        });
        setPreviewError(false);
      } else if (target) {
        target.location.replace(url);
      }
    } catch (error) {
      target?.close();
      if (mounted.current && requestGeneration === previewGeneration.current) {
        setNotice(errorMessage(error));
      }
    }
  };

  const closePreview = () => {
    previewGeneration.current += 1;
    setPreview(null);
  };

  const events = audit.data?.pages.flatMap((page) => page.events) ?? [];
  const crumbs = path.data?.path ?? [];
  return (
    <section className="admin-files" aria-label="全利用者のファイル">
      <div className="admin-files-banner">
        <strong>管理者として閲覧中</strong>
        <span>
          読み取り専用です。ファイル一覧、プレビュー、ダウンロードの閲覧履歴を記録します。
        </span>
      </div>
      {notice ? (
        <p className="admin-files-notice" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="admin-files-owner">
        <label htmlFor="admin-file-owner">利用者</label>
        <select
          id="admin-file-owner"
          value={owner?.id ?? ""}
          onChange={(event) => setOwnerId(event.currentTarget.value)}
          disabled={!owners.length}
        >
          {owners.map((user) => (
            <option key={user.id} value={user.id}>
              {user.email}
              {user.disabled ? "（無効）" : ""}
            </option>
          ))}
        </select>
        {users.hasNextPage && (
          <Button
            variant="ghost"
            onClick={() => void users.fetchNextPage()}
            disabled={users.isFetchingNextPage}
          >
            {users.isFetchingNextPage ? "読込中…" : "利用者をさらに読み込む"}
          </Button>
        )}
      </div>
      {users.error ? <p role="alert">利用者を読み込めません。{errorMessage(users.error)}</p> : null}
      {owner && (
        <div className="admin-files-owner-note">
          <strong>{owner.email}</strong> の個人ファイルを表示しています
          {owner.disabled ? <span>・この利用者は無効です</span> : null}
        </div>
      )}
      <nav className="admin-files-breadcrumbs" aria-label="フォルダー階層">
        {crumbs.map((crumb, index) => (
          <span key={crumb.id}>
            {index > 0 ? <span aria-hidden="true"> / </span> : null}
            {crumb.kind === "file" || index === crumbs.length - 1 ? (
              <strong>{crumb.name}</strong>
            ) : (
              <button type="button" onClick={() => setFolderId(crumb.id)}>
                {crumb.name}
              </button>
            )}
          </span>
        ))}
      </nav>
      {children.error || path.error ? (
        <p role="alert">
          ファイル一覧を読み込めません。{errorMessage(children.error ?? path.error)}
        </p>
      ) : children.isPending ? (
        <p>ファイル一覧を読み込んでいます…</p>
      ) : rows.length ? (
        <div className="admin-files-table" role="table" aria-label="利用者のファイル一覧">
          <div className="admin-files-row admin-files-heading" role="row">
            <span role="columnheader">名前</span>
            <span role="columnheader">更新日時</span>
            <span role="columnheader">サイズ</span>
            <span role="columnheader">閲覧</span>
          </div>
          {rows.map((node) => (
            <div className="admin-files-row" role="row" key={node.id}>
              <span role="cell">
                {node.kind === "folder" ? (
                  <button
                    className="admin-files-folder"
                    type="button"
                    onClick={() => setFolderId(node.id)}
                  >
                    <FolderOpen size={17} aria-hidden="true" />
                    {node.name}
                  </button>
                ) : (
                  <span className="admin-files-name">
                    <FileText size={17} aria-hidden="true" />
                    {node.name}
                  </span>
                )}
              </span>
              <span role="cell">{dateTime(node.updatedAt)}</span>
              <span role="cell">
                {node.size === null ? "—" : new Intl.NumberFormat("ja-JP").format(node.size)} B
              </span>
              <span role="cell" className="admin-files-actions">
                {node.kind === "file" && node.currentBlobId ? (
                  isEncryptedFile(node.name) ? (
                    <Link to="/encryption">暗号化画面で復号</Link>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => void openContent(node, "preview")}
                      >
                        プレビュー
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => void openContent(node, "download")}
                      >
                        ダウンロード
                      </Button>
                    </>
                  )
                ) : (
                  "—"
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="admin-files-empty">このフォルダーに項目はありません。</p>
      )}
      {children.hasNextPage ? (
        <Button
          variant="ghost"
          onClick={() => void children.fetchNextPage()}
          disabled={children.isFetchingNextPage}
        >
          {children.isFetchingNextPage ? "読込中…" : "次の項目を読み込む"}
        </Button>
      ) : null}
      <section className="admin-files-history" aria-labelledby="admin-files-history-heading">
        <h2 id="admin-files-history-heading">閲覧履歴</h2>
        {audit.error ? (
          <p role="alert">閲覧履歴を読み込めません。{errorMessage(audit.error)}</p>
        ) : null}
        {events.length ? (
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                <time dateTime={new Date(event.occurredAt).toISOString()}>
                  {dateTime(event.occurredAt)}
                </time>
                <span>
                  {event.action === "preview"
                    ? "プレビュー"
                    : event.action === "download"
                      ? "ダウンロード"
                      : "ファイル情報の閲覧"}
                </span>
                <span>所有者: {ownerById.get(event.ownerId)?.email ?? "利用者"}</span>
                <span>閲覧者: {event.actorId === account.id ? account.email : "管理者"}</span>
                <span title={event.nodeId}>ファイル ID: {event.nodeId}</span>
              </li>
            ))}
          </ul>
        ) : audit.isPending ? (
          <p>閲覧履歴を読み込んでいます…</p>
        ) : (
          <p>記録された閲覧履歴はありません。</p>
        )}
        {audit.hasNextPage ? (
          <Button
            variant="ghost"
            onClick={() => void audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            履歴をさらに表示
          </Button>
        ) : null}
      </section>
      {preview ? (
        <div className="admin-media-preview-backdrop">
          <section
            className="admin-media-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`プレビュー: ${preview.name}`}
          >
            <header>
              <div>
                <strong>{preview.name}</strong>
                <small>{preview.ownerEmail} のファイル · 読み取り専用</small>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="プレビューを閉じる"
                onClick={closePreview}
              >
                <X size={18} />
              </Button>
            </header>
            {preview.mime.startsWith("audio/") ? (
              <audio
                controls
                autoPlay
                preload="metadata"
                src={preview.url}
                aria-label={preview.name}
                onError={() => setPreviewError(true)}
              />
            ) : (
              <video
                controls
                autoPlay
                preload="metadata"
                playsInline
                src={preview.url}
                aria-label={preview.name}
                onError={() => setPreviewError(true)}
              />
            )}
            {previewError ? (
              <div role="alert" className="admin-media-preview-error">
                <span>このメディアを再生できませんでした。</span>
                <Button variant="ghost" onClick={() => void openContent(preview.node, "download")}>
                  原本をダウンロード
                </Button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
