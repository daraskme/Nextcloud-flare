import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { type Account, ApiError, api, errorMessage, formatBytes } from "../../lib/api";
import {
  beginCopyRetry,
  COPY_RECORDS_CHANGED,
  type CopyRecord,
  clearCopyRetry,
  forgetCopy,
  readCopyRecords,
  rememberCopyRetry,
} from "./records";

function CopyProgress({
  account,
  record,
  onCompleted,
}: {
  account: Account;
  record: CopyRecord;
  onCompleted: () => void;
}) {
  const query = useQueryClient(),
    queryKey = ["copy-job", account.id, account.epoch, record.id];
  const job = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.copyJob(record.id, signal),
    retry: false,
    refetchInterval: (query) => {
      const error = query.state.error,
        status = query.state.data;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false;
      if (error) return 10_000;
      if (
        status?.state === "completed" ||
        (status && ["failed", "cancelled"].includes(status.state) && !status.cleanupPending)
      )
        return false;
      return 3000;
    },
  });
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const notified = useRef(false),
    status = job.error ? undefined : job.data;
  useEffect(() => {
    if (status?.state && ["completed", "cancelled", "failed"].includes(status.state))
      setFailure("");
  }, [status?.state]);
  useEffect(() => {
    if (status?.state === "completed" && !notified.current) {
      notified.current = true;
      onCompleted();
    }
  }, [status?.state, onCompleted]);
  useEffect(() => {
    if (status?.retryJobId && status.retryJobId !== record.retriedJobId) {
      try {
        rememberCopyRetry(account, record.id, status.retryJobId);
        setFailure("");
      } catch (error) {
        setFailure(errorMessage(error));
      }
    }
    // The status can be unchanged after storage becomes available again. Each
    // successful refresh must retry saving the accepted successor in that case.
  }, [
    account.id,
    account.epoch,
    record.id,
    record.retriedJobId,
    status?.retryJobId,
    job.dataUpdatedAt,
  ]);
  const terminal = status && ["completed", "cancelled", "failed"].includes(status.state);
  const dismiss = () => {
    try {
      forgetCopy(account, record.id);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };
  return (
    <article className="copy-job" aria-label={`${record.name}のコピー`} data-job-id={record.id}>
      <div className="copy-job-heading">
        <strong>{record.name}</strong>
        {(terminal || (job.error instanceof ApiError && job.error.status === 404)) && (
          <Button
            size="small"
            variant="ghost"
            disabled={busy || !!record.retryKey}
            onClick={dismiss}
          >
            表示を閉じる
          </Button>
        )}
      </div>
      {job.error ? (
        <p role="alert">{errorMessage(job.error)}</p>
      ) : !status ? (
        <p>コピーの進捗を確認しています</p>
      ) : (
        <>
          <p role="status">
            {status.state === "completed"
              ? "コピー完了"
              : status.state === "cancelled"
                ? "コピーを取り消しました"
                : status.state === "failed"
                  ? "コピーを完了できませんでした"
                  : status.state === "pending"
                    ? "コピーの開始を待っています"
                    : status.completedBlobs === status.blobCount
                      ? "コピーを確定しています"
                      : "コピー中"}
          </p>
          <progress
            aria-label={`${record.name}のコピー進捗`}
            max={status.totalBytes || 1}
            value={status.totalBytes ? status.completedBytes : status.state === "completed" ? 1 : 0}
          />
          <span>
            {formatBytes(status.completedBytes)} / {formatBytes(status.totalBytes)}
          </span>
          {!terminal && <p>転送済みの量です。コピー完了後に保存先へ表示されます。</p>}
          {!!status.cleanupPending && (
            <p>容量の精算を待っています。保持中: {formatBytes(status.heldBytes)}</p>
          )}
          {record.retriedJobId && (
            <p>再試行を受け付けました。新しいコピーの項目で進捗を確認できます。</p>
          )}
          {["cancelled", "failed"].includes(status.state) &&
            !status.cleanupPending &&
            !record.retriedJobId &&
            !status.retryJobId && <p>再試行すると、現在の内容を同じ保存先へ新しくコピーします。</p>}
          {status.state === "completed" &&
            (record.destinationShare ? (
              <Link
                to="/shared/$shareId/$nodeId"
                params={{ shareId: record.destinationShare.id, nodeId: record.destinationParentId }}
              >
                保存先を開く
              </Link>
            ) : (
              <Link to="/files/$folderId" params={{ folderId: record.destinationParentId }}>
                保存先を開く
              </Link>
            ))}
        </>
      )}
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      <div className="copy-job-actions">
        {status &&
          ["cancelled", "failed"].includes(status.state) &&
          !status.cleanupPending &&
          !record.retriedJobId &&
          !status.retryJobId && (
            <Button
              size="small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailure("");
                try {
                  const key = beginCopyRetry(account, record.id);
                  const operation = await api.retryCopyJob(record.id, key);
                  if (!operation.result?.jobId) throw new Error("invalid_copy_receipt");
                  rememberCopyRetry(account, record.id, operation.result.jobId);
                } catch (error) {
                  if (error instanceof ApiError && [400, 409, 413, 423].includes(error.status)) {
                    try {
                      clearCopyRetry(account, record.id);
                    } catch {
                      /* Keep the original key. */
                    }
                  }
                  setFailure(errorMessage(error));
                } finally {
                  setBusy(false);
                  void query.invalidateQueries({ queryKey });
                }
              }}
            >
              {record.retryKey ? "再試行の結果を確認" : "コピーを再試行"}
            </Button>
          )}
        <Button
          size="small"
          variant="ghost"
          disabled={busy || job.isFetching}
          onClick={() => {
            setFailure("");
            void job.refetch();
          }}
        >
          進捗を更新
        </Button>
        {status && !terminal && (
          <Button
            size="small"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure("");
              try {
                query.setQueryData(queryKey, await api.cancelCopyJob(record.id));
              } catch (error) {
                setFailure(errorMessage(error));
              } finally {
                setBusy(false);
                void query.invalidateQueries({ queryKey });
              }
            }}
          >
            コピーを取り消す
          </Button>
        )}
      </div>
    </article>
  );
}

export function CopyJobsPanel({
  account,
  onCompleted,
}: {
  account: Account;
  onCompleted: () => void;
}) {
  const [records, setRecords] = useState<CopyRecord[]>([]),
    [failure, setFailure] = useState("");
  const [visible, setVisible] = useState(5);
  useEffect(() => {
    const update = () => {
      try {
        setRecords(readCopyRecords(account));
        setFailure("");
      } catch (error) {
        setRecords([]);
        setFailure(errorMessage(error));
      }
    };
    update();
    window.addEventListener(COPY_RECORDS_CHANGED, update);
    return () => window.removeEventListener(COPY_RECORDS_CHANGED, update);
  }, [account.id, account.epoch]);
  if (!records.length && !failure) return null;
  return (
    <section className="copy-jobs" aria-label="コピー状況">
      <h2>コピー状況</h2>
      {failure && <p role="alert">{failure}</p>}
      {records.slice(0, visible).map((record) => (
        <CopyProgress key={record.id} account={account} record={record} onCompleted={onCompleted} />
      ))}
      {records.length > visible && (
        <Button size="small" onClick={() => setVisible((n) => n + 5)}>
          さらにコピーを表示
        </Button>
      )}
    </section>
  );
}
