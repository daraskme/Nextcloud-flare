import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MailPlus, RefreshCw, UserRoundPlus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button";
import { type Account, type AdminInvite, api, errorMessage } from "../../lib/api";

const formatDate = (value: number) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);

function isPending(invite: AdminInvite, now: number) {
  return invite.revokedAt === null && invite.claimedAt === null && invite.expiresAt > now;
}

export function AdminInvites({ account }: { account: Account }) {
  const query = useQueryClient();
  const [email, setEmail] = useState("");
  const [revokeFailure, setRevokeFailure] = useState("");
  const invites = useQuery({
    queryKey: ["admin-invites", account.id, account.epoch],
    queryFn: ({ signal }) => api.adminInvites(signal),
  });
  const create = useMutation({
    mutationFn: (value: string) => api.createAdminInvite(value),
    onSuccess: () => {
      setEmail("");
      void query.invalidateQueries({ queryKey: ["admin-invites", account.id, account.epoch] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAdminInvite(id),
    onSuccess: () => {
      setRevokeFailure("");
      void query.invalidateQueries({ queryKey: ["admin-invites", account.id, account.epoch] });
    },
    onError: (error) => setRevokeFailure(errorMessage(error)),
  });

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim();
    if (!value || create.isPending) return;
    create.mutate(value);
  };

  const pending = invites.data?.invites.filter((invite) => isPending(invite, Date.now())) ?? [];

  return (
    <section className="settings-card" aria-labelledby="admin-invites-title">
      <div className="settings-card-heading app-password-list-heading">
        <div>
          <h2 id="admin-invites-title">利用者の招待</h2>
          <p>Access 認証後の初回ログインで一般利用者として登録します。</p>
        </div>
        <Button
          size="small"
          aria-label="招待一覧を更新"
          disabled={invites.isFetching}
          onClick={() => void invites.refetch()}
        >
          <RefreshCw size={15} className={invites.isFetching ? "spin" : ""} />
          更新
        </Button>
      </div>
      <p className="muted admin-invites-guidance">
        対象者のメールアドレスは Cloudflare Access
        の許可設定にも追加してください。この画面から招待メールは送信されません。
      </p>
      <p className="muted admin-invites-guidance">
        招待の有効期間は7日間です。Accessで認証されるメールアドレスと完全一致する必要があります。
      </p>
      <form className="admin-invite-form" onSubmit={add}>
        <label className="field-label" htmlFor="admin-invite-email">
          メールアドレス
          <input
            id="admin-invite-email"
            type="email"
            autoComplete="email"
            required
            maxLength={320}
            value={email}
            disabled={create.isPending}
            onChange={(event) => {
              setEmail(event.target.value);
              create.reset();
            }}
          />
        </label>
        <Button type="submit" variant="primary" disabled={create.isPending || !email.trim()}>
          {create.isPending ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <MailPlus size={16} aria-hidden="true" />
          )}
          追加
        </Button>
      </form>
      {create.error && (
        <p role="alert" className="form-error">
          {errorMessage(create.error)}
        </p>
      )}
      {revokeFailure && (
        <p role="alert" className="form-error">
          {revokeFailure}
        </p>
      )}
      {invites.isPending ? (
        <p className="app-password-list-status" role="status">
          <LoaderCircle size={18} className="spin" aria-hidden="true" />
          招待を読み込んでいます
        </p>
      ) : invites.error ? (
        <div className="app-password-list-status">
          <p role="alert">{errorMessage(invites.error)}</p>
          <Button size="small" onClick={() => void invites.refetch()}>
            再試行
          </Button>
        </div>
      ) : pending.length === 0 ? (
        <div className="app-password-empty">
          <UserRoundPlus size={28} aria-hidden="true" />
          <p>保留中の招待はありません。</p>
        </div>
      ) : (
        <ul className="app-password-list" aria-label="保留中の招待">
          {pending.map((invite) => (
            <li key={invite.id}>
              <div className="app-password-list-primary">
                <strong>{invite.email}</strong>
                <span>保留中</span>
              </div>
              <dl>
                <div>
                  <dt>有効期限</dt>
                  <dd>{formatDate(invite.expiresAt)}</dd>
                </div>
              </dl>
              <Button
                size="small"
                variant="danger"
                aria-label={`${invite.email}の招待を取り消す`}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(invite.id)}
              >
                <X size={15} aria-hidden="true" />
                取り消し
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
