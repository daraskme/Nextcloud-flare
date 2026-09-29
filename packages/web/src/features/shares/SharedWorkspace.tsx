import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  Copy,
  Download,
  File,
  Folder,
  FolderPlus,
  Info,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import type { InternalShare } from "../../../../shared/src/shares";
import { Button } from "../../components/ui/button";
import {
  type Account,
  api,
  errorMessage,
  type FileNode,
  formatBytes,
  zipErrorMessage,
} from "../../lib/api";
import { PrivateAudio } from "../audio/PrivateAudio";
import { PrivateGallery } from "../gallery/PrivateGallery";
import { PrivateBook } from "../library/PrivateBook";
import { PrivateLibrary } from "../library/PrivateLibrary";
import { uploads } from "../uploads/manager";

export interface SharedActionScope {
  share: InternalShare;
  parentId: string | null;
}
type SharedActions = {
  onAction: (
    action:
      | { kind: "create" }
      | { kind: "rename" | "overwrite" | "move" | "copy" | "trash" | "media"; node: FileNode },
    scope: SharedActionScope,
  ) => void;
  writesBlocked: boolean;
};

function Loading() {
  return (
    <div className="empty-state" role="status">
      <LoaderCircle className="spin" size={26} />
      <p>共有を読み込んでいます</p>
    </div>
  );
}
function Failure({ error, refresh }: { error: unknown; refresh: () => void }) {
  return (
    <div className="empty-state" role="alert">
      <p>{typeof error === "string" ? error : errorMessage(error)}</p>
      <Button onClick={refresh}>
        <RefreshCw size={16} />
        共有を読み直す
      </Button>
    </div>
  );
}
function ReceivedShares({ account }: { account: Account }) {
  const list = useInfiniteQuery({
    queryKey: ["received-shares", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.sharedWithMe(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
  });
  const shares =
    !list.error && !list.isRefetching ? (list.data?.pages.flatMap((p) => p.items) ?? []) : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SHARED WITH YOU</p>
          <h1>共有された項目</h1>
          <p>ほかのユーザーがあなたに共有したファイルとフォルダー。</p>
        </div>
        <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
          <RefreshCw size={16} />
          共有を更新
        </Button>
      </div>
      {list.error ? (
        <Failure error={list.error} refresh={() => void list.refetch()} />
      ) : list.isPending || list.isRefetching ? (
        <Loading />
      ) : (
        <>
          <div className="shared-list" aria-label="共有された項目の一覧">
            {shares.map((share) => (
              <article className="shared-row" key={share.id}>
                {share.nodeKind === "file" ? <File size={24} /> : <Folder size={24} />}
                <Link className="shared-entry" to="/shared/$shareId" params={{ shareId: share.id }}>
                  <strong>{share.name || "ドライブ"}</strong>
                  <span>
                    {share.role === "read" ? "閲覧" : "編集"}
                    {share.expiresAt !== null &&
                      ` · ${new Date(share.expiresAt).toLocaleString("ja-JP")}まで`}
                  </span>
                </Link>
                <ChevronRight aria-hidden="true" size={18} />
              </article>
            ))}
          </div>
          {!shares.length && (
            <div className="empty-state">
              <Folder size={42} />
              <h2>共有された項目はありません</h2>
              <p>アクセスできる共有がここに表示されます。</p>
            </div>
          )}
          {list.hasNextPage && (
            <div className="list-footer">
              <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                さらに共有を読み込む
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
function SharedContent({
  account,
  share,
  nodeId,
  refresh,
  onAction,
  writesBlocked,
}: {
  account: Account;
  share: InternalShare;
  nodeId: string | undefined;
  refresh: () => void;
} & SharedActions) {
  const selected = { id: share.id, version: share.version };
  const id = nodeId ?? share.rootNodeId;
  const [book, setBook] = useState<FileNode | null>(null);
  const [library, setLibrary] = useState(
    () => new URLSearchParams(window.location.search).get("view") === "library",
  );
  const [gallery, setGallery] = useState(false);
  const [audio, setAudio] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [uploadFailure, setUploadFailure] = useState("");
  const [zipFailure, setZipFailure] = useState("");
  const [zipBusy, setZipBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const node = useQuery({
    queryKey: ["shared-node", account.id, account.epoch, share.id, share.version, id],
    queryFn: ({ signal }) => api.node(id, selected, signal),
    retry: false,
    gcTime: 0,
  });
  const path = useQuery({
    queryKey: ["shared-path", account.id, account.epoch, share.id, share.version, id],
    queryFn: ({ signal }) => api.path(id, signal, selected),
    retry: false,
    gcTime: 0,
  });
  const folder = !!node.data && node.data.kind !== "file" && !node.error;
  const children = useInfiniteQuery({
    queryKey: ["shared-children", account.id, account.epoch, share.id, share.version, id],
    queryFn: ({ pageParam, signal }) => api.children(id, pageParam, signal, selected),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: folder,
    retry: false,
    gcTime: 0,
  });
  const error = failure || node.error || path.error || (folder && children.error);
  const loading =
    node.isFetching || path.isFetching || (folder && (children.isPending || children.isRefetching));
  const editable = share.role === "edit" && !error && !loading;
  const addFiles = async (files: FileList | null) => {
    if (!files || !editable || !folder || writesBlocked || adding) return;
    setAdding(true);
    setUploadFailure("");
    try {
      for (const file of Array.from(files))
        await uploads.enqueue(file, account, id, undefined, {
          spaceId: share.spaceId,
          share: selected,
        });
    } catch (error) {
      setUploadFailure(error instanceof Error ? error.message : "アップロードを開始できません。");
    } finally {
      setAdding(false);
    }
  };
  const open = (file: FileNode) => {
    if (file.kind === "file" && /\.(zip|cbz)$/i.test(file.name)) {
      setBook(file);
      return;
    }
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setFailure("ファイルを開くには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    void api
      .openFile(account, file, target, { spaceId: share.spaceId, share: selected })
      .catch((error) => setFailure(errorMessage(error)));
  };
  const downloadZip = (nodeId: string) => {
    if (zipBusy) return;
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setZipFailure("ZIPを保存するには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    setZipBusy(true);
    setZipFailure("");
    void api
      .downloadZip(nodeId, target, selected)
      .catch((error) => setZipFailure(zipErrorMessage(error)))
      .finally(() => setZipBusy(false));
  };
  let files: FileNode[] = [];
  if (!error && !loading) {
    if (folder) files = children.data?.pages.flatMap((page) => page.children) ?? [];
    else if (node.data?.kind === "file") {
      const { parentId, ...file } = node.data;
      files = [{ ...file, kind: "file", ...(parentId ? { parentId } : {}) }];
    }
  }
  return (
    <>
      {book && !error && (
        <PrivateBook
          key={`${share.id}:${share.version}:${book.id}`}
          account={account}
          node={book}
          share={{ ...selected, spaceId: share.spaceId }}
          close={() => setBook(null)}
        />
      )}
      <div className="breadcrumbs" aria-label="パンくず">
        <Link to="/shared">共有された項目</Link>
        {!error &&
          !loading &&
          path.data?.path.map((crumb) => (
            <span key={crumb.id}>
              <ChevronRight size={13} />
              {crumb.kind === "file" ? (
                <span>{crumb.name}</span>
              ) : (
                <Link
                  to="/shared/$shareId/$nodeId"
                  params={{ shareId: share.id, nodeId: crumb.id }}
                >
                  {crumb.name || "ドライブ"}
                </Link>
              )}
            </span>
          ))}
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SHARED WITH YOU</p>
          <h1>{!error && !loading ? node.data?.name || "共有ドライブ" : "共有された項目"}</h1>
          <p>
            {share.role === "edit"
              ? "共有された項目の追加・編集・移動・コピー・削除ができます。"
              : "共有されたファイルを開いて保存できます。"}
          </p>
        </div>
        <Button disabled={loading} onClick={refresh}>
          <RefreshCw size={16} />
          共有を更新
        </Button>
      </div>
      {error ? (
        <Failure error={error} refresh={refresh} />
      ) : loading ? (
        <Loading />
      ) : (
        <>
          <p className="shared-access">共有の権限：{share.role === "read" ? "閲覧" : "編集"}</p>
          {folder && (
            <Button
              className="copy-current-folder"
              disabled={zipBusy}
              aria-label="このフォルダーをZIPで保存"
              onClick={() => downloadZip(id)}
            >
              {zipBusy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
              ZIPで保存
            </Button>
          )}
          {folder && node.data && (
            <Button
              className="copy-current-folder"
              disabled={writesBlocked}
              onClick={() => {
                const { parentId: originalParent, ...current } = node.data!;
                onAction(
                  { kind: "copy", node: { ...current, kind: "folder" } },
                  { share, parentId: originalParent },
                );
              }}
            >
              <Copy size={16} />
              このフォルダーをコピー
            </Button>
          )}
          {editable && folder && (
            <div className="shared-actions">
              <Button
                disabled={writesBlocked}
                onClick={() => onAction({ kind: "create" }, { share, parentId: id })}
              >
                <FolderPlus size={16} />
                新規フォルダー
              </Button>
              <Button disabled={writesBlocked || adding} onClick={() => input.current?.click()}>
                <Upload size={16} />
                アップロード
              </Button>
            </div>
          )}
          {zipFailure && (
            <p className="form-error" role="alert">
              {zipFailure}
            </p>
          )}
          {uploadFailure && (
            <p className="form-error" role="alert">
              {uploadFailure}
            </p>
          )}
          <input
            ref={input}
            type="file"
            hidden
            multiple
            aria-label="共有先にアップロードするファイル"
            disabled={!editable || writesBlocked || adding}
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            onClick={() => {
              setLibrary(false);
              setAudio(false);
              setGallery((x) => !x);
            }}
          >
            {gallery ? "ファイル一覧へ戻る" : "ギャラリーで表示"}
          </Button>
          <Button
            onClick={() => {
              setLibrary(false);
              setGallery(false);
              setAudio((x) => !x);
            }}
          >
            {audio ? "ファイル一覧へ戻る" : "オーディオで表示"}
          </Button>
          <Button
            onClick={() => {
              setAudio(false);
              setGallery(false);
              setLibrary((value) => !value);
            }}
          >
            {library ? "ファイル一覧へ戻る" : "本棚で表示"}
          </Button>
          {library ? (
            <PrivateLibrary
              account={account}
              rootId={id}
              share={{ ...selected, spaceId: share.spaceId }}
            />
          ) : audio ? (
            <PrivateAudio
              account={account}
              rootId={id}
              share={{ ...selected, spaceId: share.spaceId }}
            />
          ) : gallery ? (
            <PrivateGallery
              account={account}
              rootId={id}
              share={{ ...selected, spaceId: share.spaceId }}
            />
          ) : (
            <>
              <div className="shared-list" aria-label="共有フォルダーの項目">
                {files.map((file) => (
                  <article className="shared-row" key={file.id}>
                    {file.kind === "folder" ? <Folder size={24} /> : <File size={24} />}
                    {file.kind === "folder" ? (
                      <Link
                        className="shared-entry"
                        to="/shared/$shareId/$nodeId"
                        params={{ shareId: share.id, nodeId: file.id }}
                      >
                        <strong>{file.name}</strong>
                        <span>フォルダー</span>
                      </Link>
                    ) : (
                      <button type="button" className="shared-entry" onClick={() => open(file)}>
                        <strong>{file.name}</strong>
                        <span>{formatBytes(file.size)} · 開く・保存</span>
                      </button>
                    )}
                    <div className="shared-row-actions">
                      {file.kind === "file" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={file.name + "のメディア情報を読み込む"}
                          onClick={() =>
                            onAction(
                              { kind: "media", node: file },
                              { share, parentId: folder ? id : (file.parentId ?? null) },
                            )
                          }
                        >
                          <Info size={16} />
                        </Button>
                      )}
                      {file.kind === "folder" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${file.name}をZIPで保存`}
                          disabled={zipBusy}
                          onClick={() => downloadZip(file.id)}
                        >
                          <Download size={16} />
                        </Button>
                      )}
                      {(!editable || file.id === share.rootNodeId) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${file.name}をコピー`}
                          disabled={writesBlocked}
                          onClick={() =>
                            onAction(
                              { kind: "copy", node: file },
                              { share, parentId: folder ? id : (file.parentId ?? null) },
                            )
                          }
                        >
                          <Copy size={16} />
                        </Button>
                      )}
                      {editable && (
                        <>
                          {file.id !== share.rootNodeId && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${file.name}の名前を変更`}
                              disabled={writesBlocked}
                              onClick={() =>
                                onAction(
                                  { kind: "rename", node: file },
                                  { share, parentId: folder ? id : (file.parentId ?? null) },
                                )
                              }
                            >
                              <Pencil size={16} />
                            </Button>
                          )}
                          {file.kind === "file" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${file.name}を上書き`}
                              disabled={writesBlocked}
                              onClick={() =>
                                onAction(
                                  { kind: "overwrite", node: file },
                                  { share, parentId: folder ? id : (file.parentId ?? null) },
                                )
                              }
                            >
                              <Upload size={16} />
                            </Button>
                          )}
                          {file.id !== share.rootNodeId && (
                            <details className="shared-more">
                              <summary aria-label={`${file.name}のその他の操作`}>
                                <MoreHorizontal size={18} />
                              </summary>
                              <div className="shared-more-items">
                                {(["move", "copy", "trash"] as const).map((kind) => (
                                  <Button
                                    key={kind}
                                    variant="ghost"
                                    disabled={writesBlocked}
                                    onClick={(event) => {
                                      event.currentTarget
                                        .closest("details")
                                        ?.removeAttribute("open");
                                      onAction(
                                        { kind, node: file },
                                        { share, parentId: folder ? id : (file.parentId ?? null) },
                                      );
                                    }}
                                  >
                                    {kind === "move"
                                      ? "移動"
                                      : kind === "copy"
                                        ? "コピー"
                                        : "ごみ箱に移動"}
                                  </Button>
                                ))}
                              </div>
                            </details>
                          )}
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!files.length && !children.hasNextPage && (
                <div className="empty-state">
                  <Folder size={42} />
                  <h2>この共有フォルダーは空です</h2>
                </div>
              )}
              {folder && children.hasNextPage && (
                <div className="list-footer">
                  <Button
                    disabled={children.isFetchingNextPage}
                    onClick={() => void children.fetchNextPage()}
                  >
                    さらに読み込む
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
function SharedItem({
  account,
  shareId,
  nodeId,
  onAction,
  writesBlocked,
}: {
  account: Account;
  shareId: string;
  nodeId: string | undefined;
} & SharedActions) {
  const detail = useQuery({
    queryKey: ["received-share", account.id, account.epoch, shareId],
    queryFn: ({ signal }) => api.share(shareId, signal),
    retry: false,
    gcTime: 0,
  });
  const share = !detail.error && !detail.isFetching ? detail.data : undefined;
  return detail.error ? (
    <>
      <Link to="/shared">共有された項目へ戻る</Link>
      <Failure error={detail.error} refresh={() => void detail.refetch()} />
    </>
  ) : share?.ownerId === account.id ? (
    <>
      <Link to="/shared">共有された項目へ戻る</Link>
      <p>自分のファイルはマイドライブから開いてください。</p>
    </>
  ) : !share ? (
    <Loading />
  ) : (
    <SharedContent
      key={`${share.id}:${share.version}:${nodeId ?? "root"}`}
      account={account}
      share={share}
      nodeId={nodeId}
      refresh={() => void detail.refetch()}
      onAction={onAction}
      writesBlocked={writesBlocked}
    />
  );
}
export function SharedWorkspace({
  account,
  shareId,
  nodeId,
  onAction,
  writesBlocked,
}: {
  account: Account;
  shareId: string | undefined;
  nodeId: string | undefined;
} & SharedActions) {
  return shareId ? (
    <SharedItem
      account={account}
      shareId={shareId}
      nodeId={nodeId}
      onAction={onAction}
      writesBlocked={writesBlocked}
    />
  ) : (
    <ReceivedShares account={account} />
  );
}
