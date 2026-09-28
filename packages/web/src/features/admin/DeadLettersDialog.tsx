import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { DeadLetter } from "../../../../shared/src/deadLetters";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, api, errorMessage } from "../../lib/api";

function state(item: DeadLetter): string {
  if (!item.outboxId) return "メッセージ形式が不正";
  if (!item.eventState) return "元の処理が見つかりません";
  const labels = {
    pending: "待機中",
    dispatching: "配信中",
    sent: "配信済み",
    running: "実行中",
    completed: "完了",
    failed: "停止",
    cancelled: "取消済み",
  };
  return labels[item.jobState ?? item.eventState];
}

export function DeadLettersDialog({ account, close }: { account: Account; close: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const listing = useInfiniteQuery({
    queryKey: ["admin-dlq", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.deadLetters(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  // A failed refresh may mean role/session revocation. Hide all cached operational metadata.
  const pages = !listing.error && !listing.isFetching ? listing.data?.pages : undefined;
  const items = pages?.flatMap((page) => page.items);
  const requeue = async (item: DeadLetter) => {
    if (!item.outboxId || pending) return;
    setPending(item.messageId);
    setNotice("");
    try {
      await api.requeueDeadLetter(item.outboxId, item.messageId);
      setNotice("再配信を受け付けました。処理が完了するまで状態を更新して確認してください。");
      await listing.refetch();
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 409
          ? "実行中、停止済み、または受付済みなどの理由で再投入できません。更新して状態を確認してください。"
          : "受付を確認できませんでした。更新して受付済みか確認してください。再度押した場合も同じ要求を照合します。",
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <Dialog
      title="配信失敗の記録"
      description="繰り返し配信できなかった処理を新しい順に表示します。現在は完了している処理も含まれます。"
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {listing.isFetching && <p role="status">記録を読み込んでいます</p>}
      {listing.error && <p role="alert">{errorMessage(listing.error)}</p>}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {items?.length === 0 && <p>配信失敗の記録はありません。</p>}
      {!!items?.length && (
        <>
          <p className="muted">停止したコピーの容量解放には、別途確認が必要な場合があります。</p>
          <ol className="dead-letter-list" aria-label="配信失敗の一覧">
            {items.map((item) => (
              <li key={item.messageId}>
                <div className="dead-letter-heading">
                  <strong>{state(item)}</strong>
                  <time dateTime={new Date(item.receivedAt).toISOString()}>
                    {new Date(item.receivedAt).toLocaleString("ja-JP")}
                  </time>
                </div>
                <dl>
                  <div>
                    <dt>記録ID</dt>
                    <dd>{item.messageId}</dd>
                  </div>
                  {item.outboxId && (
                    <div>
                      <dt>配信ID</dt>
                      <dd>{item.outboxId}</dd>
                    </div>
                  )}
                  {item.jobId && (
                    <div>
                      <dt>コピーID</dt>
                      <dd>{item.jobId}</dd>
                    </div>
                  )}
                  {item.eventEpoch !== null && item.eventEpoch !== account.epoch && (
                    <div>
                      <dt>復旧前の処理</dt>
                      <dd>世代 {item.eventEpoch}</dd>
                    </div>
                  )}
                  {item.requeuedAt !== null && (
                    <div>
                      <dt>再配信受付</dt>
                      <dd>{new Date(item.requeuedAt).toLocaleString("ja-JP")}</dd>
                    </div>
                  )}
                </dl>
                {item.requeuedAt === null &&
                  item.outboxId &&
                  item.eventEpoch === account.epoch &&
                  ["pending", "dispatching", "sent"].includes(item.eventState ?? "") &&
                  (item.jobState === null || ["pending", "running"].includes(item.jobState)) && (
                    <Button
                      disabled={pending !== null || listing.isFetching}
                      onClick={() => void requeue(item)}
                    >
                      {pending === item.messageId ? "受付中…" : "再配信を予約"}
                    </Button>
                  )}
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="dialog-actions">
        {listing.hasNextPage && !listing.error && (
          <Button disabled={listing.isFetching} onClick={() => void listing.fetchNextPage()}>
            続きを読み込む
          </Button>
        )}
        <Button disabled={listing.isFetching} onClick={() => void listing.refetch()}>
          更新
        </Button>
        <Button variant="primary" onClick={close}>
          閉じる
        </Button>
      </div>
    </Dialog>
  );
}
