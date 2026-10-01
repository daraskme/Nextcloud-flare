import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Clipboard,
  Download,
  Folder,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type Account,
  type AppPassword,
  type AppPasswordScope,
  api,
  type CreatedAppPassword,
  errorMessage,
} from "../../lib/api";

const SCOPE_OPTIONS: readonly {
  scope: AppPasswordScope;
  label: string;
  description: string;
}[] = [
  { scope: "node:read", label: "読み取り", description: "フォルダーの一覧とファイルの取得" },
  { scope: "node:create", label: "作成", description: "ファイルとフォルダーの新規作成" },
  { scope: "node:write", label: "更新", description: "既存ファイルの置換と名前・場所の変更" },
  { scope: "node:delete", label: "削除", description: "ファイルとフォルダーの削除" },
];

const formatDate = (value: number) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);

function RootFolderPicker({
  account,
  value,
  onChange,
}: {
  account: Account;
  value: string;
  onChange: (nodeId: string) => void;
}) {
  const path = useQuery({
    queryKey: ["app-password-root-path", account.id, account.epoch, value],
    queryFn: ({ signal }) => api.path(value, signal),
  });
  const listing = useInfiniteQuery({
    queryKey: ["app-password-root-children", account.id, account.epoch, value],
    queryFn: ({ pageParam, signal }) => api.children(value, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const folders =
    listing.data?.pages.flatMap((page) => page.children).filter((node) => node.kind === "folder") ??
    [];
  const current = path.data?.path.at(-1);
  const parent = path.data?.path.at(-2);

  return (
    <div className="app-password-root-picker">
      <div className="app-password-root-current">
        <Folder size={18} aria-hidden="true" />
        <span>
          <small>選択中</small>
          <strong>{current?.name || "マイドライブ"}</strong>
        </span>
        {value !== account.rootNodeId && (
          <Button
            size="small"
            variant="ghost"
            onClick={() => onChange(parent?.id ?? account.rootNodeId)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            上へ
          </Button>
        )}
      </div>
      {listing.isPending ? (
        <p className="muted app-password-picker-status" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          サブフォルダーを読み込んでいます
        </p>
      ) : folders.length ? (
        <div className="app-password-folder-list" aria-label="ルートフォルダーを選択">
          {folders.map((folder) => (
            <button type="button" key={folder.id} onClick={() => onChange(folder.id)}>
              <Folder size={17} aria-hidden="true" />
              <span>{folder.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted app-password-picker-status">この場所にサブフォルダーはありません。</p>
      )}
      {listing.hasNextPage && (
        <Button
          size="small"
          disabled={listing.isFetchingNextPage}
          onClick={() => void listing.fetchNextPage()}
        >
          さらに読み込む
        </Button>
      )}
      {(path.error || listing.error) && (
        <p role="alert" className="form-error">
          {errorMessage(path.error ?? listing.error)}
        </p>
      )}
    </div>
  );
}

function CredentialDialog({
  credential,
  onDismiss,
}: {
  credential: CreatedAppPassword;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"username" | "password" | null>(null);
  const [failure, setFailure] = useState("");
  const endpoint = `${window.location.origin}/dav`;

  const copy = async (kind: "username" | "password", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setFailure("");
    } catch {
      setFailure("クリップボードにコピーできませんでした。手動で選択してください。");
    }
  };
  const download = () => {
    const blob = new Blob(
      [
        [
          `WebDAV endpoint: ${endpoint}`,
          `Username: ${credential.id}`,
          `Password: ${credential.secret}`,
          "",
          "This password is shown once. Store it in a trusted password manager.",
        ].join("\n"),
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nextcloud-flare-webdav-credential.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open
      title="アプリパスワードを保存"
      description="このシークレットは今だけ表示され、閉じると再表示できません。"
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <div className="one-time-credential" data-testid="one-time-credential">
        <p className="credential-warning">
          <ShieldCheck size={20} aria-hidden="true" />
          信頼できるパスワードマネージャーへ保存してから閉じてください。
        </p>
        <label>
          WebDAV エンドポイント
          <input readOnly value={endpoint} />
        </label>
        <label>
          ユーザー名（アプリパスワード ID）
          <span className="credential-field">
            <input readOnly value={credential.id} data-testid="app-password-username" />
            <Button
              size="small"
              aria-label="ユーザー名をコピー"
              onClick={() => void copy("username", credential.id)}
            >
              {copied === "username" ? <Check size={15} /> : <Clipboard size={15} />}
              {copied === "username" ? "コピー済み" : "コピー"}
            </Button>
          </span>
        </label>
        <label>
          パスワード（今回だけ表示）
          <span className="credential-field">
            <input
              readOnly
              value={credential.secret}
              data-testid="app-password-secret"
              aria-describedby="credential-storage-guidance"
            />
            <Button
              size="small"
              aria-label="パスワードをコピー"
              onClick={() => void copy("password", credential.secret)}
            >
              {copied === "password" ? <Check size={15} /> : <Clipboard size={15} />}
              {copied === "password" ? "コピー済み" : "コピー"}
            </Button>
          </span>
        </label>
        <p id="credential-storage-guidance" className="muted">
          アプリはこの値を
          URL、ブラウザーストレージ、一覧データへ保存しません。ダウンロードした場合はファイルを安全に管理してください。
        </p>
        {failure && (
          <p role="alert" className="form-error">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={download}>
            <Download size={16} aria-hidden="true" />
            認証情報をダウンロード
          </Button>
          <Button variant="primary" onClick={onDismiss}>
            保存しました。閉じる
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RevokeDialog({
  password,
  pending,
  failure,
  onCancel,
  onConfirm,
}: {
  password: AppPassword;
  pending: boolean;
  failure: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      title="アプリパスワードを失効"
      description={`「${password.name}」を失効すると、この認証情報で発行されたコンテンツセッションも利用できなくなります。`}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      <div className="dialog-actions">
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          キャンセル
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
          失効する
        </Button>
      </div>
    </Dialog>
  );
}

export function WebDavSettings({ account }: { account: Account }) {
  const query = useQueryClient();
  const passwords = useQuery({
    queryKey: ["app-passwords", account.id, account.epoch],
    queryFn: ({ signal }) => api.appPasswords(signal),
  });
  const [name, setName] = useState("");
  const [ttlDays, setTtlDays] = useState(90);
  const [scopes, setScopes] = useState<AppPasswordScope[]>(["node:read"]);
  const [limitRoot, setLimitRoot] = useState(false);
  const [rootNodeId, setRootNodeId] = useState(account.rootNodeId);
  const [created, setCreated] = useState<CreatedAppPassword | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [createFailure, setCreateFailure] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<AppPassword | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeFailure, setRevokeFailure] = useState("");
  const createRequest = useRef<AbortController | null>(null);
  const revokeRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      createRequest.current?.abort();
      revokeRequest.current?.abort();
    },
    [],
  );

  const toggleScope = (scope: AppPasswordScope, checked: boolean) => {
    setScopes((current) =>
      checked ? [...current, scope] : current.filter((candidate) => candidate !== scope),
    );
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (createPending || scopes.length === 0) return;
    const controller = new AbortController();
    createRequest.current?.abort();
    createRequest.current = controller;
    setCreatePending(true);
    setCreateFailure("");
    try {
      const credential = await api.createAppPassword(
        {
          name,
          scopes,
          ttlDays,
          ...(limitRoot ? { spaceId: account.spaceId, rootNodeId } : {}),
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setCreated(credential);
      setName("");
      setScopes(["node:read"]);
      setTtlDays(90);
      setLimitRoot(false);
      setRootNodeId(account.rootNodeId);
      await query.invalidateQueries({ queryKey: ["app-passwords", account.id, account.epoch] });
    } catch (error) {
      if (!controller.signal.aborted) setCreateFailure(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setCreatePending(false);
      if (createRequest.current === controller) createRequest.current = null;
    }
  };
  const revoke = async () => {
    if (!revokeTarget || revokePending) return;
    const target = revokeTarget;
    const controller = new AbortController();
    revokeRequest.current?.abort();
    revokeRequest.current = controller;
    setRevokePending(true);
    setRevokeFailure("");
    try {
      await api.revokeAppPassword(target.credentialId, controller.signal);
      controller.signal.throwIfAborted();
      query.setQueryData<{ passwords: AppPassword[] }>(
        ["app-passwords", account.id, account.epoch],
        (current) =>
          current
            ? { passwords: current.passwords.filter((password) => password.id !== target.id) }
            : current,
      );
      setRevokeTarget(null);
      await query.invalidateQueries({ queryKey: ["app-passwords", account.id, account.epoch] });
    } catch (error) {
      if (!controller.signal.aborted) setRevokeFailure(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setRevokePending(false);
      if (revokeRequest.current === controller) revokeRequest.current = null;
    }
  };

  return (
    <div className="webdav-settings">
      <section className="settings-card webdav-guidance" aria-labelledby="webdav-connection-title">
        <div className="settings-card-heading">
          <span className="settings-icon">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 id="webdav-connection-title">WebDAV 接続情報</h2>
            <p>アプリパスワードを作成し、対応クライアントへ手動で設定します。</p>
          </div>
        </div>
        <dl className="webdav-contract">
          <div>
            <dt>エンドポイント</dt>
            <dd>
              <code>{window.location.origin}/dav</code>
            </dd>
          </div>
          <div>
            <dt>ユーザー名</dt>
            <dd>作成時に表示されるアプリパスワード ID</dd>
          </div>
          <div>
            <dt>パスワード</dt>
            <dd>作成時に一度だけ表示されるシークレット</dd>
          </div>
        </dl>
        <p className="muted">
          HTTPS Basic
          認証として入力してください。この画面は認証情報を発行しますが、リモートクライアントの設定完了は確認しません。
        </p>
      </section>

      <section className="settings-card" aria-labelledby="create-app-password-title">
        <div className="settings-card-heading">
          <span className="settings-icon">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 id="create-app-password-title">アプリパスワードを作成</h2>
            <p>必要な操作とフォルダーだけにアクセスを限定できます。</p>
          </div>
        </div>
        <form className="app-password-form" onSubmit={(event) => void create(event)}>
          <label className="field-label">
            名前
            <input
              required
              maxLength={100}
              value={name}
              disabled={createPending}
              placeholder="例: ノート PC の WebDAV"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field-label app-password-expiry">
            有効期間
            <span>
              <input
                required
                type="number"
                min={1}
                max={365}
                value={ttlDays}
                disabled={createPending}
                onChange={(event) => setTtlDays(event.currentTarget.valueAsNumber)}
              />
              日（1〜365日）
            </span>
          </label>
          <fieldset className="app-password-scopes" disabled={createPending}>
            <legend>許可する操作</legend>
            {SCOPE_OPTIONS.map(({ scope, label, description }) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) => toggleScope(scope, event.target.checked)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {scopes.length === 0 && (
            <p role="alert" className="form-error">
              少なくとも 1 つの操作を選択してください。
            </p>
          )}
          <label className="app-password-root-toggle">
            <input
              type="checkbox"
              checked={limitRoot}
              disabled={createPending}
              onChange={(event) => {
                setLimitRoot(event.target.checked);
                if (!event.target.checked) setRootNodeId(account.rootNodeId);
              }}
            />
            <span>
              <strong>ルートフォルダーを限定する</strong>
              <small>自分が所有する選択フォルダー以下だけを利用できます。</small>
            </span>
          </label>
          {limitRoot && (
            <RootFolderPicker account={account} value={rootNodeId} onChange={setRootNodeId} />
          )}
          {createFailure && (
            <p role="alert" className="form-error">
              {createFailure}
            </p>
          )}
          <div className="app-password-submit">
            <p className="muted">有効なアプリパスワードは最大 20 件です。</p>
            <Button type="submit" variant="primary" disabled={createPending || scopes.length === 0}>
              {createPending ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : (
                <KeyRound size={16} aria-hidden="true" />
              )}
              作成する
            </Button>
          </div>
        </form>
      </section>

      <section className="settings-card" aria-labelledby="current-app-passwords-title">
        <div className="settings-card-heading app-password-list-heading">
          <div>
            <h2 id="current-app-passwords-title">現在のアプリパスワード</h2>
            <p>有効期限内で失効していない認証情報だけを表示します。</p>
          </div>
          <Button
            size="small"
            aria-label="アプリパスワード一覧を更新"
            disabled={passwords.isFetching}
            onClick={() => void passwords.refetch()}
          >
            <RefreshCw size={15} className={passwords.isFetching ? "spin" : ""} />
            更新
          </Button>
        </div>
        {passwords.isPending ? (
          <p className="app-password-list-status" role="status">
            <LoaderCircle size={18} className="spin" aria-hidden="true" />
            アプリパスワードを読み込んでいます
          </p>
        ) : passwords.error ? (
          <div className="app-password-list-status">
            <p role="alert">{errorMessage(passwords.error)}</p>
            <Button size="small" onClick={() => void passwords.refetch()}>
              再試行
            </Button>
          </div>
        ) : passwords.data.passwords.length === 0 ? (
          <div className="app-password-empty">
            <KeyRound size={28} aria-hidden="true" />
            <p>有効なアプリパスワードはありません。</p>
          </div>
        ) : (
          <ul className="app-password-list">
            {passwords.data.passwords.map((password) => (
              <li key={password.id}>
                <div className="app-password-list-primary">
                  <strong>{password.name}</strong>
                  <code>{password.id}</code>
                </div>
                <dl>
                  <div>
                    <dt>有効期限</dt>
                    <dd>{formatDate(password.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>操作</dt>
                    <dd>
                      {SCOPE_OPTIONS.filter(({ scope }) => password.scopes.includes(scope))
                        .map(({ label }) => label)
                        .join("・")}
                    </dd>
                  </div>
                  <div>
                    <dt>ルート</dt>
                    <dd>
                      {password.rootNodeId ? `限定 (${password.rootNodeId})` : "マイドライブ全体"}
                    </dd>
                  </div>
                </dl>
                <Button
                  size="small"
                  variant="danger"
                  aria-label={`${password.name}を失効`}
                  onClick={() => {
                    setRevokeFailure("");
                    setRevokeTarget(password);
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  失効
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {created && <CredentialDialog credential={created} onDismiss={() => setCreated(null)} />}
      {revokeTarget && (
        <RevokeDialog
          password={revokeTarget}
          pending={revokePending}
          failure={revokeFailure}
          onCancel={() => {
            setRevokeFailure("");
            setRevokeTarget(null);
          }}
          onConfirm={() => void revoke()}
        />
      )}
    </div>
  );
}
