import { useInfiniteQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import {
  type InternalShare,
  internalShareInput,
  type ShareRole,
} from "../../../../shared/src/shares";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, api, errorMessage, type FileNode } from "../../lib/api";

interface Page {
  items: InternalShare[];
  nextCursor: string | null;
}
function localDate(value: number | null) {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const part = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function ShareDialog({
  account,
  node,
  close,
}: {
  account: Account;
  node: FileNode;
  close: () => void;
}) {
  const list = useInfiniteQuery({
    queryKey: ["shares", account.id, account.epoch, node.id],
    queryFn: ({ pageParam, signal }) =>
      api.request<Page>(
        `/api/v1/shares?rootNodeId=${encodeURIComponent(node.id)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [editing, setEditing] = useState<InternalShare | null>(null);
  const [recipients, setRecipients] = useState("");
  const [role, setRole] = useState<ShareRole>("read");
  const [expires, setExpires] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const reset = () => {
    setEditing(null);
    setRecipients("");
    setRole("read");
    setExpires("");
  };
  const refresh = async () => {
    if (busy.current) return;
    const result = await list.refetch();
    if (!result.error) {
      setUncertain(false);
      setFailure("");
    }
  };
  const save = async (event?: FormEvent, disabling?: InternalShare) => {
    event?.preventDefault();
    if (busy.current || uncertain || list.error || list.isFetching) return;
    let input;
    if (!disabling) {
      try {
        input = internalShareInput({
          kind: "internal",
          rootNodeId: node.id,
          recipients: recipients.split(/[,\s]+/).filter(Boolean),
          role,
          expiresAt: expires ? new Date(expires).getTime() : null,
        });
      } catch {
        setFailure("登録済みのメールアドレスを1〜20件と、未来の有効期限を入力してください。");
        return;
      }
    }
    busy.current = true;
    setPending(true);
    setFailure("");
    setNotice("");
    try {
      const selected = disabling ?? editing;
      await api.json(
        `/api/v1/shares${selected ? `/${selected.id}` : ""}`,
        disabling ? "DELETE" : selected ? "PATCH" : "POST",
        disabling ? undefined : input,
        undefined,
        selected ? { "If-Match": `"share-${selected.version}"` } : {},
      );
      reset();
      setNotice(
        disabling
          ? "共有を停止しました。"
          : editing
            ? "共有を更新しました。"
            : "共有を作成しました。",
      );
      await list.refetch();
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      setUncertain(unknown || (error instanceof ApiError && error.status === 412));
      setFailure(
        unknown
          ? "結果を確認できませんでした。一覧を更新し、共有が作成・変更されているか確認してください。"
          : error instanceof ApiError && error.status === 412
            ? "共有が別の操作で変更されています。一覧を更新し、最新の共有を選び直してください。"
            : errorMessage(error),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const shares = !list.error ? (list.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const locked = pending || uncertain || list.isFetching || !!list.error;
  return (
    <Dialog
      title="共有を管理"
      description={`${node.name}を登録済みのユーザーと共有します。`}
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) close();
      }}
    >
      <div className="share-dialog">
        <p className="muted">
          閲覧では表示・ダウンロード、編集では追加・変更も許可します。共有の再配布やごみ箱への移動は所有者が行います。
        </p>
        {notice && <p role="status">{notice}</p>}
        {failure && (
          <p className="form-error" role="alert">
            {failure}
          </p>
        )}
        {list.error && (
          <p className="form-error" role="alert">
            {errorMessage(list.error)}
          </p>
        )}
        <div className="share-list" aria-label="設定済みの共有">
          {shares.map((share) => (
            <article key={share.id} className="share-row">
              <div>
                <strong>{share.recipients.map((user) => user.email).join(", ")}</strong>
                <p>
                  {share.role === "read" ? "閲覧" : "編集"} ·{" "}
                  {share.expiresAt === null
                    ? "期限なし"
                    : `${new Date(share.expiresAt).toLocaleString("ja-JP")}まで`}
                  {share.expiresAt !== null && share.expiresAt <= Date.now() && "（期限切れ）"}
                </p>
              </div>
              <Button
                size="small"
                disabled={locked}
                onClick={() => {
                  setEditing(share);
                  setRecipients(share.recipients.map((user) => user.email).join(", "));
                  setRole(share.role);
                  setExpires(localDate(share.expiresAt));
                  setFailure("");
                  setNotice("");
                }}
              >
                変更
              </Button>
              <Button size="small" disabled={locked} onClick={() => void save(undefined, share)}>
                共有を停止
              </Button>
            </article>
          ))}
          {list.isPending ? (
            <p role="status">読み込み中…</p>
          ) : (
            !list.error && !shares.length && <p>設定済みの共有はありません。</p>
          )}
        </div>
        <div className="dialog-actions">
          {list.hasNextPage && (
            <Button disabled={locked} onClick={() => void list.fetchNextPage()}>
              さらに読み込む
            </Button>
          )}
          <Button disabled={pending || list.isFetching} onClick={() => void refresh()}>
            共有一覧を更新
          </Button>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={locked} className="share-form">
            <legend>{editing ? "共有設定を変更" : "新しい共有"}</legend>
            <label htmlFor="share-recipients">共有相手のメールアドレス</label>
            <textarea
              id="share-recipients"
              required
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
              placeholder="user@example.com"
              rows={2}
              maxLength={5120}
              aria-describedby="share-recipient-hint"
            />
            <p id="share-recipient-hint" className="muted">
              複数の相手はカンマまたは改行で区切ってください（20件まで）。
            </p>
            <label htmlFor="share-role">権限</label>
            <select
              id="share-role"
              value={role}
              onChange={(event) => setRole(event.target.value as ShareRole)}
            >
              <option value="read">閲覧</option>
              <option value="edit">編集</option>
            </select>
            <label htmlFor="share-expires">有効期限（任意）</label>
            <input
              id="share-expires"
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
            <div className="dialog-actions">
              {editing && (
                <Button type="button" onClick={reset}>
                  変更をやめる
                </Button>
              )}
              <Button type="submit" variant="primary">
                {pending ? "保存中…" : editing ? "共有を更新" : "共有を作成"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </Dialog>
  );
}
