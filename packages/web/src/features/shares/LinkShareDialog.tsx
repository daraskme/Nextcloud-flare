import { useInfiniteQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { type LinkShare, linkShareInput } from "../../../../shared/src/linkShares";
import {
  type UploadOnlyShare,
  uploadOnlyShareInput,
} from "../../../../shared/src/uploadOnlyShares";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, api, errorMessage, type FileNode } from "../../lib/api";

type PublicShare = LinkShare | UploadOnlyShare;
interface Page {
  items: PublicShare[];
  nextCursor: string | null;
}
interface Receipt {
  id: string;
  version: number;
  secret?: string;
}
type Confirmation = { action: "rotate" | "disable"; share: PublicShare };
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
  kind = "link",
}: {
  account: Account;
  node: FileNode;
  close: () => void;
  kind?: "link" | "upload_only";
}) {
  const uploadOnly = kind === "upload_only";
  const list = useInfiniteQuery({
    queryKey: ["link-shares", kind, account.id, account.epoch, node.id],
    queryFn: ({ pageParam, signal }) =>
      api.request<Page>(
        `/api/v1/shares?kind=${kind}&rootNodeId=${encodeURIComponent(node.id)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [editing, setEditing] = useState<PublicShare | null>(null);
  const [limit, setLimit] = useState("1024");
  const [expires, setExpires] = useState("");
  const [role, setRole] = useState<"read" | "edit">("read");
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
    setRole("read");
    setLimit("1024");
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
        input = (uploadOnly ? uploadOnlyShareInput : linkShareInput)(
          {
            kind,
            rootNodeId: node.id,
            ...(uploadOnly
              ? {
                  reservationLimit:
                    confirmed && selected?.kind === "upload_only"
                      ? selected.reservationLimit
                      : limit.trim()
                        ? Number(limit) * 1048576
                        : NaN,
                }
              : { role: confirmed && selected?.kind === "link" ? selected.role : role }),
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
          uploadOnly
            ? "同時送信の上限容量、未来の有効期限、パスワードを確認してください。容量は0以上で指定してください。"
            : "未来の有効期限と、1,024バイト以内のパスワードを確認してください。パスワードを変更する場合は空欄にできません。",
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
      title={uploadOnly ? "受け取りリンクを管理" : "公開リンクを管理"}
      description={
        uploadOnly ? `${node.name}にファイルを受け取ります。` : `${node.name}をリンクで共有します。`
      }
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) close();
      }}
    >
      <div className="share-dialog">
        <p className="muted">
          {uploadOnly
            ? "リンクを受け取った人が、ログインせずにファイルを送信できます。フォルダーの内容は相手に表示されません。同名のファイルは自動で名前を変えて保存します。"
            : "リンクを受け取った人が、ログインせずに閲覧・ダウンロードできます。必要に応じて有効期限やパスワードを設定してください。"}
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
                  {share.kind === "upload_only"
                    ? "受け取り専用"
                    : share.role === "read"
                      ? "閲覧"
                      : "編集"}{" "}
                  ·{" "}
                  {share.expiresAt === null
                    ? "期限なし"
                    : `${new Date(share.expiresAt).toLocaleString("ja-JP")}まで`}
                  {share.expiresAt !== null && share.expiresAt <= Date.now() && "（期限切れ）"}
                </p>
                {share.kind === "upload_only" && (
                  <p>
                    同時送信の上限:{" "}
                    {(share.reservationLimit / 1048576).toLocaleString("ja-JP", {
                      maximumFractionDigits: 6,
                    })}{" "}
                    MiB · 送信・回収待ち: {share.reservedBytes.toLocaleString()} bytes
                  </p>
                )}
                <small>
                  作成: {new Date(share.createdAt).toLocaleString("ja-JP")} · {share.id.slice(-8)}
                </small>
              </div>
              <Button
                size="small"
                disabled={locked || !!confirmation}
                onClick={() => {
                  setEditing(share);
                  if (share.kind === "upload_only")
                    setLimit(String(share.reservationLimit / 1048576));
                  else setRole(share.role);
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
              <legend>{editing ? "リンク設定を変更" : "新しい公開リンク"}</legend>
              {uploadOnly ? (
                <>
                  <label htmlFor="link-limit">同時送信の上限容量（MiB）</label>
                  <input
                    id="link-limit"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                  />
                  <p className="muted">
                    送信中と回収待ちのファイルに使える容量です。保存済みのファイルを含むアカウント全体の空き容量も必要です。0にすると空ファイル以外の新しい送信を止めます。
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor="link-role">共有権限</label>
                  <select
                    id="link-role"
                    value={role}
                    onChange={(event) => setRole(event.target.value as typeof role)}
                  >
                    <option value="read">閲覧</option>
                    <option value="edit">編集</option>
                  </select>
                  {role === "edit" && (
                    <p className="muted">
                      リンクを受け取った人が、アップロード・上書き・フォルダー作成・名前変更・ごみ箱への移動を行えます。
                    </p>
                  )}
                </>
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
                  {pending
                    ? "保存中…"
                    : editing
                      ? "リンク設定を保存"
                      : uploadOnly
                        ? "受け取りリンクを作成"
                        : role === "read"
                          ? "閲覧リンクを作成"
                          : "編集リンクを作成"}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </Dialog>
  );
}
