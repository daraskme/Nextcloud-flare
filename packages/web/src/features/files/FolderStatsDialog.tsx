import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, api, errorMessage, formatBytes } from "../../lib/api";

export function FolderStatsDialog({
  account,
  scopeId,
  close,
}: {
  account: Account;
  scopeId: string;
  close: () => void;
}) {
  const stats = useQuery({
    queryKey: ["stats", account.id, account.epoch, scopeId],
    queryFn: ({ signal }) => api.stats(scopeId, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  // Never display a cached total while refreshing or after authorization fails.
  const value = !stats.isFetching && !stats.error ? stats.data : undefined;
  const partial = !!value && (value.truncated || value.unavailableFiles > 0);
  return (
    <Dialog
      title="フォルダーの情報"
      description="このフォルダーとサブフォルダーの現在のファイルを集計します。ごみ箱と過去のバージョンは含みません。"
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {stats.isFetching && (
        <p className="folder-stats-loading" role="status">
          <LoaderCircle size={18} className="spin" /> 集計しています
        </p>
      )}
      {stats.error && <p role="alert">{errorMessage(stats.error)}</p>}
      {value && (
        <>
          <dl className="folder-stats" aria-label="フォルダーの集計結果">
            <div>
              <dt>ファイル</dt>
              <dd>{value.fileCount.toLocaleString("ja-JP")} 件</dd>
            </div>
            <div>
              <dt>サブフォルダー</dt>
              <dd>{value.folderCount.toLocaleString("ja-JP")} 件</dd>
            </div>
            <div>
              <dt>{partial ? "確認できた合計サイズ" : "合計サイズ"}</dt>
              <dd title={`${value.totalBytes.toLocaleString("ja-JP")} bytes`}>
                {formatBytes(value.totalBytes)}
              </dd>
            </div>
          </dl>
          {partial && (
            <p className="notice" role="status">
              集計結果は一部です。
              {value.truncated
                ? "項目数または階層の上限に達しました。対象のサブフォルダーを開いて確認してください。"
                : "サイズを確認できないファイルがあります。時間をおいて再集計してください。"}
            </p>
          )}
          <p className="muted">コピーしたファイルは、それぞれのサイズを合計します。</p>
        </>
      )}
      <div className="dialog-actions">
        <Button disabled={stats.isFetching} onClick={() => void stats.refetch()}>
          <RefreshCw size={16} /> 再集計
        </Button>
        <Button onClick={close}>閉じる</Button>
      </div>
    </Dialog>
  );
}
