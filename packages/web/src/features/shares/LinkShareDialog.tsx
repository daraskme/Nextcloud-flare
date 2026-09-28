import { useInfiniteQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { type LinkShare, linkShareInput } from "../../../../shared/src/linkShares";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, api, errorMessage, type FileNode } from "../../lib/api";

interface Page {
  items: LinkShare[];
  nextCursor: string | null;
}
interface Receipt {
  id: string;
  version: number;
  secret?: string;
}
type Confirmation = { action: "rotate" | "disable"; share: LinkShare };
function localDate(value: number | null) {
  if (value === null) return "";
  const date = new Date(value),
    part = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}
function shareUrl(receipt: Receipt) {
  if (
    typeof receipt.id !== "string" ||
    !Number.isSafeInteger(receipt.version) ||
    receipt.version < 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id) ||
    typeof receipt.secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(receipt.secret)
  )
    throw new Error("invalid_share_receipt");
  return `${location.origin}/s/${receipt.id}#${receipt.secret}`;
}
export function LinkShareDialog({
  account,
  node,
  close,
}: {
  account: Account;
  node: FileNode;
  close: () => void;
}) {
  const list = useInfiniteQuery({
    queryKey: ["link-shares", account.id, account.epoch, node.id],
    queryFn: ({ pageParam, signal }) =>
      api.request<Page>(
        `/api/v1/shares?kind=link&rootNodeId=${encodeURIComponent(node.id)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [editing, setEditing] = useState<LinkShare | null>(null);
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState<"keep" | "set" | "remove">("keep");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [issued, setIssued] = useState<{ id: string; url: string } | null>(null);
  const [pending, setPending] = useState(false),
    busy = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState(""),
    [notice, setNotice] = useState("");
  const reset = () => {
    setEditing(null);
    setExpires("");
    setPassword("");
    setPasswordMode("keep");
    setConfirmation(null);
  };
  const locked = pending || uncertain || list.isFetching || !!list.error;
  const shares = list.error ? [] : (list.data?.pages.flatMap((page) => page.items) ?? []);
  async function refresh() {
    if (busy.current) return;
    setIssued(null);
    setConfirmation(null);
    const result = await list.refetch();
    if (!result.error) {
      reset();
      setFailure("");
      setNotice(
        uncertain
          ? "一覧を更新しました。作成・変更されたリンクを確認してください。URLが手元にない場合は、そのリンクを再発行してください。"
          : "リンク一覧を更新しました。",
      );
      setUncertain(false);
    }
  }
  async function save(event?: FormEvent, confirmed?: Confirmation) {
    event?.preventDefault();
    if (busy.current || locked) return;
    const selected = confirmed?.share ?? editing;
    let input;
    if (confirmed?.action !== "disable") {
      try {
        input = linkShareInput(
          {
            kind: "link",
            rootNodeId: node.id,
            role: selected?.role ?? "read",
            expiresAt: confirmed
              ? selected!.expiresAt
              : expires
                ? new Date(expires).getTime()
                : null,
            ...(confirmed
              ? { rotateSecret: true }
              : editing
                ? passwordMode === "set"
                  ? { password }
                  : passwordMode === "remove"
                    ? { password: null }
                    : {}
                : password
                  ? { password }
                  : {}),
          },
          !!selected,
        );
      } catch {
        setFailure(
          "未来の有効期限と、1,024バイト以内のパスワードを確認してください。パスワードを変更する場合は空欄にできません。",
        );
        return;
      }
    }
    busy.current = true;
    setPending(true);
    setFailure("");
    setNotice("");
    setIssued(null);
    try {
      const saved = await api.json<Receipt>(
        `/api/v1/shares${selected ? `/${selected.id}` : ""}`,
        confirmed?.action === "disable" ? "DELETE" : selected ? "PATCH" : "POST",
        input,
        undefined,
        selected ? { "If-Match": `"share-${selected.version}"` } : {},
      );
      const url = !selected || confirmed?.action === "rotate" ? shareUrl(saved) : null;
      reset();
      setNotice(
        confirmed?.action === "disable"
          ? "公開リンクを停止しました。"
          : url
            ? "リンクを発行しました。閉じる前にURLをコピーしてください。"
            : "リンク設定を更新しました。利用中の閲覧セッションは終了します。URLは変わりません。",
      );
      if (url) setIssued({ id: saved.id, url });
      const refreshed = await list.refetch();
      if (refreshed.error) {
        setIssued(null);
        setNotice(
          "操作は完了しました。一覧を再取得してください。URLをコピーできなかった場合は、リンクを再発行してください。",
        );
      }
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      setUncertain(unknown || (error instanceof ApiError && [404, 412].includes(error.status)));
      setConfirmation(null);
      setFailure(
        unknown
          ? "結果を確認できませんでした。リンク一覧を更新して作成・変更の有無を確認してください。URLを受け取れなかった場合は、作成済みのリンクを再発行してください。"
          : error instanceof ApiError && error.status === 412
            ? "リンクが別の操作で変更されています。一覧を更新し、最新の設定を選び直してください。"
            : errorMessage(error),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setNotice("共有URLをコピーしました。");
    } catch {
      setFailure("コピーできませんでした。共有URLを選択してコピーしてください。");
    }
  }
  return (
    <Dialog
      title="公開リンクを管理"
      description={`${node.name}をリンクで共有します。`}
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) close();
      }}
    >
      <div className="share-dialog">
        <p className="muted">
          リンクを受け取った人が、ログインせずに閲覧・ダウンロードできます。必要に応じて有効期限やパスワードを設定してください。
        </p>
        {notice && <p role="status">{notice}</p>}
        {failure && (
          <p role="alert" className="form-error">
            {failure}
          </p>
        )}
        {list.error && (
          <p role="alert" className="form-error">
            {errorMessage(list.error)}
          </p>
        )}
        {issued && !list.error && (
          <section className="share-issued" aria-label="発行した共有URL">
            <label htmlFor="issued-share-url">共有URL</label>
            <input
              id="issued-share-url"
              readOnly
              value={issued.url}
              onFocus={(event) => event.target.select()}
              spellCheck={false}
            />
            <p className="muted">
              このURLは閉じると再表示できません。再発行すると以前のURLは使えなくなります。
            </p>
            <div className="dialog-actions">
              <Button onClick={() => void copy()}>URLをコピー</Button>
              <a href={issued.url} target="_blank" rel="noreferrer">
                共有画面を開く
              </a>
            </div>
          </section>
        )}
        <div className="share-list" aria-label="設定済みの公開リンク">
          {shares.map((share) => (
            <article className="share-row" key={share.id} aria-label={`公開リンク ${share.id}`}>
              <div>
                <strong>{share.hasPassword ? "パスワードあり" : "パスワードなし"}</strong>
                <p>
                  {share.role === "read" ? "閲覧" : "編集"} ·{" "}
                  {share.expiresAt === null
                    ? "期限なし"
                    : `${new Date(share.expiresAt).toLocaleString("ja-JP")}まで`}
                  {share.expiresAt !== null && share.expiresAt <= Date.now() && "（期限切れ）"}
                </p>
                <small>
                  作成: {new Date(share.createdAt).toLocaleString("ja-JP")} · {share.id.slice(-8)}
                </small>
              </div>
              <Button
                size="small"
                disabled={locked || !!confirmation}
                onClick={() => {
                  setEditing(share);
                  setExpires(localDate(share.expiresAt));
                  setPassword("");
                  setPasswordMode("keep");
                  setIssued(null);
                  setFailure("");
                  setNotice("");
                }}
              >
                設定を変更
              </Button>
              <Button
                size="small"
                disabled={locked || !!confirmation}
                onClick={() => {
                  setConfirmation({ action: "rotate", share });
                  setIssued(null);
                  setFailure("");
                }}
              >
                リンクを再発行
              </Button>
              <Button
                size="small"
                disabled={locked || !!confirmation}
                onClick={() => {
                  setConfirmation({ action: "disable", share });
                  setIssued(null);
                  setFailure("");
                }}
              >
                リンクを停止
              </Button>
            </article>
          ))}
          {list.isPending ? (
            <p role="status">読み込み中…</p>
          ) : (
            !list.error && !shares.length && <p>公開リンクはありません。</p>
          )}
        </div>
        <div className="dialog-actions">
          {list.hasNextPage && (
            <Button
              disabled={locked || !!confirmation}
              onClick={() => {
                setIssued(null);
                void list.fetchNextPage();
              }}
            >
              さらに読み込む
            </Button>
          )}
          <Button disabled={pending || list.isFetching} onClick={() => void refresh()}>
            リンク一覧を更新
          </Button>
        </div>
        {confirmation ? (
          <section className="share-confirm" aria-label="公開リンクの操作確認">
            <strong>
              {confirmation.action === "rotate"
                ? "リンクを再発行しますか？"
                : "公開リンクを停止しますか？"}
            </strong>
            <p>
              {confirmation.action === "rotate"
                ? "以前のURLと利用中の閲覧セッションは使えなくなります。新しいURLを共有相手へ渡してください。"
                : "このリンクと利用中の閲覧セッションは使えなくなります。共有元のファイルは残ります。"}
            </p>
            {confirmation.action === "rotate" &&
              confirmation.share.expiresAt !== null &&
              confirmation.share.expiresAt <= Date.now() && (
                <p>期限切れです。先に設定を変更して有効期限を更新してください。</p>
              )}
            <div className="dialog-actions">
              <Button disabled={pending} onClick={() => setConfirmation(null)}>
                戻る
              </Button>
              <Button
                variant="danger"
                disabled={
                  locked ||
                  (confirmation.action === "rotate" &&
                    confirmation.share.expiresAt !== null &&
                    confirmation.share.expiresAt <= Date.now())
                }
                onClick={() => void save(undefined, confirmation)}
              >
                {confirmation.action === "rotate" ? "再発行する" : "停止する"}
              </Button>
            </div>
          </section>
        ) : (
          <form onSubmit={(event) => void save(event)}>
            <fieldset className="share-form" disabled={locked}>
              <legend>{editing ? "リンク設定を変更" : "新しい閲覧リンク"}</legend>
              {editing?.role === "edit" && (
                <p className="muted">このリンクの編集権限を維持して設定を更新します。</p>
              )}
              <label htmlFor="link-expires">有効期限（任意）</label>
              <input
                id="link-expires"
                type="datetime-local"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
              {editing && (
                <>
                  <label htmlFor="link-password-mode">パスワード設定</label>
                  <select
                    id="link-password-mode"
                    value={passwordMode}
                    onChange={(event) => {
                      setPasswordMode(event.target.value as typeof passwordMode);
                      setPassword("");
                    }}
                  >
                    <option value="keep">現在の設定を維持</option>
                    <option value="set">新しいパスワードを設定</option>
                    <option value="remove">パスワードを解除</option>
                  </select>
                </>
              )}
              {(!editing || passwordMode === "set") && (
                <>
                  <label htmlFor="link-password">
                    {editing ? "新しいパスワード" : "パスワード（任意）"}
                  </label>
                  <input
                    id="link-password"
                    type="password"
                    autoComplete="new-password"
                    required={!!editing}
                    maxLength={1024}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </>
              )}
              {editing && (
                <p className="muted">
                  保存すると利用中の閲覧セッションは終了します。共有URLは変わりません。
                </p>
              )}
              <div className="dialog-actions">
                {editing && (
                  <Button type="button" onClick={reset}>
                    変更をやめる
                  </Button>
                )}
                <Button type="submit" variant="primary">
                  {pending ? "保存中…" : editing ? "リンク設定を保存" : "閲覧リンクを作成"}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </Dialog>
  );
}
