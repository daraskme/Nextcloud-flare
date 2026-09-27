import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, File, Folder, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { InternalShare } from "../../../../shared/src/shares";
import { Button } from "../../components/ui/button";
import { type Account, api, errorMessage, type FileNode, formatBytes } from "../../lib/api";

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
}: {
  account: Account;
  share: InternalShare;
  nodeId: string | undefined;
  refresh: () => void;
}) {
  const selected = { id: share.id, version: share.version };
  const id = nodeId ?? share.rootNodeId;
  const [failure, setFailure] = useState<string | null>(null);
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
  const open = (file: FileNode) => {
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
          <p>共有されたファイルを開いて保存できます。</p>
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
                <ChevronRight aria-hidden="true" size={18} />
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
  );
}
function SharedItem({
  account,
  shareId,
  nodeId,
}: {
  account: Account;
  shareId: string;
  nodeId: string | undefined;
}) {
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
    />
  );
}
export function SharedWorkspace({
  account,
  shareId,
  nodeId,
}: {
  account: Account;
  shareId: string | undefined;
  nodeId: string | undefined;
}) {
  return shareId ? (
    <SharedItem account={account} shareId={shareId} nodeId={nodeId} />
  ) : (
    <ReceivedShares account={account} />
  );
}
