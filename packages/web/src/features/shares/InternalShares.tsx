import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Download,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Share2,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type Account,
  api,
  errorMessage,
  type InternalShare,
  type InternalShareResharePolicyInput,
  type SharedMount,
  type ShareGroup,
} from "../../lib/api";

const DAY_MS = 86_400_000;
const date = (value: number) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);

interface PolicyDraft {
  enabled: boolean;
  download: boolean;
  expires: boolean;
  ttlDays: number;
  maxDepth: number;
  maxFanout: number;
}

const policyInput = (draft: PolicyDraft): InternalShareResharePolicyInput => ({
  enabled: draft.enabled,
  actions: draft.download ? ["read", "download"] : ["read"],
  maxDepth: draft.maxDepth,
  maxFanout: draft.maxFanout,
  ...(draft.expires ? { ttlDays: draft.ttlDays } : {}),
});

function ResharePolicyFields({
  draft,
  setDraft,
  allowDownload,
  maxTtlDays,
}: {
  draft: PolicyDraft;
  setDraft: (draft: PolicyDraft) => void;
  allowDownload: boolean;
  maxTtlDays: number;
}) {
  return (
    <div className="internal-policy-fields">
      <label className="internal-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        再共有を有効にする
      </label>
      <div className="internal-policy-grid">
        <div className="field-label">
          <span>再共有できる操作</span>
          <span className="internal-policy-actions">
            <label>
              <input type="checkbox" checked disabled /> 閲覧
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.download}
                disabled={!allowDownload}
                onChange={(event) => setDraft({ ...draft, download: event.target.checked })}
              />{" "}
              ダウンロード
            </label>
          </span>
        </div>
        <label className="field-label">
          最大委任深度
          <select
            value={draft.maxDepth}
            onChange={(event) => setDraft({ ...draft, maxDepth: Number(event.target.value) })}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          最大ファンアウト
          <input
            type="number"
            min={1}
            max={20}
            required
            value={draft.maxFanout}
            onChange={(event) => setDraft({ ...draft, maxFanout: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="internal-check">
        <input
          type="checkbox"
          checked={draft.expires}
          disabled={maxTtlDays < 1}
          onChange={(event) => setDraft({ ...draft, expires: event.target.checked })}
        />
        ポリシー独自の有効期限を設定
      </label>
      {draft.expires && (
        <label className="field-label">
          ポリシー有効期間（日）
          <input
            type="number"
            min={1}
            max={maxTtlDays}
            required
            value={draft.ttlDays}
            onChange={(event) => setDraft({ ...draft, ttlDays: Number(event.target.value) })}
          />
        </label>
      )}
      <p className="internal-inline-note">
        再共有は元の共有とこのポリシーの両方に含まれる操作だけに制限されます。
      </p>
    </div>
  );
}

function FolderPicker({
  account,
  folderId,
  setFolderId,
}: {
  account: Account;
  folderId: string;
  setFolderId: (folderId: string) => void;
}) {
  const path = useQuery({
    queryKey: ["share-picker-path", account.id, account.epoch, folderId],
    queryFn: ({ signal }) => api.path(folderId, signal),
  });
  const children = useQuery({
    queryKey: ["share-picker-children", account.id, account.epoch, folderId],
    queryFn: ({ signal }) => api.children(folderId, null, signal),
  });
  const folders = children.data?.children.filter((node) => node.kind === "folder") ?? [];
  return (
    <div className="internal-folder-picker">
      <div className="internal-folder-path" aria-label="共有するフォルダーの場所">
        {(path.data?.path ?? []).map((crumb) => (
          <button key={crumb.id} type="button" onClick={() => setFolderId(crumb.id)}>
            {crumb.id === account.rootNodeId ? "マイドライブ" : crumb.name}
          </button>
        ))}
      </div>
      {path.error || children.error ? (
        <div className="internal-inline-error" role="alert">
          <span>{errorMessage(path.error ?? children.error)}</span>
          <Button
            size="small"
            onClick={() => {
              void path.refetch();
              void children.refetch();
            }}
          >
            再試行
          </Button>
        </div>
      ) : children.isPending ? (
        <p className="internal-loading">
          <LoaderCircle className="spin" size={16} />
          フォルダーを読み込んでいます
        </p>
      ) : folders.length ? (
        <div className="internal-folder-list">
          {folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => setFolderId(folder.id)}>
              <Folder size={17} />
              <span>{folder.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="internal-folder-empty">この中にサブフォルダーはありません。</p>
      )}
      <p className="internal-folder-selected">
        <ShieldCheck size={15} />
        現在のフォルダーを共有します
      </p>
    </div>
  );
}

function CreateInternalShareDialog({
  account,
  groups,
  groupsPending,
  groupsError,
  retryGroups,
  close,
}: {
  account: Account;
  groups: readonly ShareGroup[];
  groupsPending: boolean;
  groupsError: unknown;
  retryGroups: () => void;
  close: () => void;
}) {
  const query = useQueryClient();
  const [folderId, setFolderId] = useState(account.rootNodeId);
  const [recipientKind, setRecipientKind] = useState<"direct" | "group">("direct");
  const [email, setEmail] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [download, setDownload] = useState(true);
  const [ttlDays, setTtlDays] = useState(30);
  const [configurePolicy, setConfigurePolicy] = useState(false);
  const [policy, setPolicy] = useState<PolicyDraft>({
    enabled: true,
    download: true,
    expires: false,
    ttlDays: 30,
    maxDepth: 1,
    maxFanout: 5,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!groupId && groups[0]) setGroupId(groups[0].id);
  }, [groupId, groups]);
  useEffect(() => {
    setPolicy((current) => ({
      ...current,
      download: download && current.download,
      ttlDays: Math.min(current.ttlDays, ttlDays),
    }));
  }, [download, ttlDays]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const recipient =
      recipientKind === "direct" ? { email: email.trim() } : { groupId: groupId.trim() };
    if (!("email" in recipient ? recipient.email : recipient.groupId)) {
      setFailure("共有相手を指定してください。");
      return;
    }
    setPending(true);
    setFailure("");
    try {
      await api.createInternalShare(
        folderId,
        account.spaceId,
        recipient,
        download ? ["read", "download"] : ["read"],
        ttlDays,
        configurePolicy ? policyInput(policy) : undefined,
      );
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
      close();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="内部共有を作成"
      description="ログイン済みの相手だけが利用できる、読み取り専用の共有を作成します。"
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <form className="internal-share-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending}>
          <legend>共有するフォルダー</legend>
          <FolderPicker account={account} folderId={folderId} setFolderId={setFolderId} />
        </fieldset>
        <fieldset disabled={pending}>
          <legend>共有相手</legend>
          <div className="internal-segmented">
            <button
              type="button"
              aria-pressed={recipientKind === "direct"}
              onClick={() => setRecipientKind("direct")}
            >
              <UserRound size={16} />
              ユーザー
            </button>
            <button
              type="button"
              aria-pressed={recipientKind === "group"}
              onClick={() => setRecipientKind("group")}
            >
              <UsersRound size={16} />
              グループ
            </button>
          </div>
          {recipientKind === "direct" ? (
            <label className="field-label">
              相手のメールアドレス
              <input
                required
                type="email"
                maxLength={320}
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          ) : groupsPending ? (
            <p className="internal-loading">
              <LoaderCircle className="spin" size={16} />
              共有グループを読み込んでいます
            </p>
          ) : groupsError ? (
            <div className="internal-inline-error" role="alert">
              <span>{errorMessage(groupsError)}</span>
              <Button size="small" onClick={retryGroups}>
                再試行
              </Button>
            </div>
          ) : groups.length ? (
            <label className="field-label">
              共有グループ
              <select required value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}（{group.memberEmails.length}人）
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="internal-inline-note">
              利用できる共有グループがありません。グループ API
              で登録済みのグループだけを選択できます。
            </p>
          )}
        </fieldset>
        <fieldset disabled={pending}>
          <legend>有効期限と操作</legend>
          <label className="field-label">
            有効期間
            <select value={ttlDays} onChange={(event) => setTtlDays(Number(event.target.value))}>
              <option value={7}>7日</option>
              <option value={30}>30日</option>
              <option value={90}>90日</option>
              <option value={365}>365日</option>
            </select>
          </label>
          <label className="internal-check">
            <input
              type="checkbox"
              checked={download}
              onChange={(event) => setDownload(event.target.checked)}
            />
            ファイルのダウンロードを許可
          </label>
          <p className="internal-inline-note">
            フォルダーの閲覧は常に必要です。アップロード・変更・削除は許可されません。
          </p>
        </fieldset>
        <fieldset disabled={pending}>
          <legend>再共有ポリシー</legend>
          <label className="internal-check">
            <input
              type="checkbox"
              checked={configurePolicy}
              onChange={(event) => setConfigurePolicy(event.target.checked)}
            />
            再共有ポリシーを設定
          </label>
          {configurePolicy && (
            <ResharePolicyFields
              draft={policy}
              setDraft={setPolicy}
              allowDownload={download}
              maxTtlDays={ttlDays}
            />
          )}
          {!configurePolicy && (
            <p className="internal-inline-note">
              ポリシーを設定しない共有は、受信者がさらに共有することはできません。
            </p>
          )}
        </fieldset>
        {failure && (
          <p className="form-error" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" disabled={pending} onClick={close}>
            閉じる
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={
              pending ||
              (recipientKind === "group" && (groupsPending || !!groupsError || !groups.length))
            }
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <Share2 size={16} />}
            共有を作成
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PolicySummary({ share }: { share: InternalShare }) {
  const policy = share.resharePolicy;
  if (!policy)
    return (
      <div className="internal-policy-summary">
        <strong>再共有ポリシー</strong>
        <span>未設定</span>
      </div>
    );
  return (
    <div className="internal-policy-summary">
      <strong>{share.sourceShareId ? "適用中の再共有ポリシー" : "再共有ポリシー"}</strong>
      <span>{policy.enabled ? "有効" : "無効"}</span>
      <span>操作: {policy.actions.includes("download") ? "閲覧・ダウンロード" : "閲覧のみ"}</span>
      <span>最大深度 {policy.maxDepth}</span>
      <span>最大ファンアウト {policy.maxFanout}</span>
      <span>期限: {policy.expiresAt ? date(policy.expiresAt) : "共有本体の期限まで"}</span>
    </div>
  );
}

function ResharePolicyDialog({
  account,
  share,
  close,
}: {
  account: Account;
  share: InternalShare;
  close: () => void;
}) {
  const query = useQueryClient();
  const maxTtlDays =
    share.expiresAt === null
      ? 365
      : Math.max(0, Math.floor((share.expiresAt - Date.now()) / DAY_MS));
  const policyTtlDays = share.resharePolicy?.expiresAt
    ? Math.max(1, Math.floor((share.resharePolicy.expiresAt - Date.now()) / DAY_MS))
    : Math.min(30, Math.max(1, maxTtlDays));
  const [draft, setDraft] = useState<PolicyDraft>({
    enabled: share.resharePolicy?.enabled ?? false,
    download:
      share.actions.includes("download") &&
      (share.resharePolicy?.actions.includes("download") ?? false),
    expires: share.resharePolicy?.expiresAt !== null && share.resharePolicy !== null,
    ttlDays: Math.min(policyTtlDays, Math.max(1, maxTtlDays)),
    maxDepth: share.resharePolicy?.maxDepth ?? 1,
    maxFanout: share.resharePolicy?.maxFanout ?? 5,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (draft.expires && maxTtlDays < 1) {
      setFailure("共有本体の期限まで24時間未満のため、ポリシー期限を更新できません。");
      return;
    }
    setPending(true);
    setFailure("");
    try {
      await api.updateInternalShare(share.id, { resharePolicy: policyInput(draft) });
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
      close();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title="再共有ポリシーを編集"
      description="元の共有を超えない範囲で、受信者が委任できる操作と上限を設定します。"
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <form className="internal-share-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending}>
          <legend>{share.rootName ?? share.mountName ?? "内部共有"}</legend>
          <ResharePolicyFields
            draft={draft}
            setDraft={setDraft}
            allowDownload={share.actions.includes("download")}
            maxTtlDays={maxTtlDays}
          />
        </fieldset>
        {share.resharePolicy?.expiresAt && (
          <p className="internal-inline-note">
            期限を設定したまま保存すると、入力した日数を保存時点から再設定します。
          </p>
        )}
        {failure && (
          <p className="form-error" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" disabled={pending} onClick={close}>
            閉じる
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            ポリシーを保存
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function OwnedShareCard({
  account,
  share,
  revoke,
  editPolicy,
}: {
  account: Account;
  share: InternalShare;
  revoke: (share: InternalShare) => void;
  editPolicy: (share: InternalShare) => void;
}) {
  const query = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const active =
    share.disabledAt === null && (share.expiresAt === null || share.expiresAt > Date.now());
  const download = share.actions.includes("download");
  const changeDownload = async () => {
    setPending(true);
    setFailure("");
    try {
      await api.updateInternalShare(share.id, {
        actions: download ? ["read"] : ["read", "download"],
      });
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="internal-card">
      <div className="internal-card-heading">
        <span className="internal-card-icon">
          <Folder size={20} />
        </span>
        <div>
          <h3>{share.rootName ?? share.mountName}</h3>
          <p>
            {share.recipientGroupId ? (
              <>
                <UsersRound size={14} />
                {share.recipientGroupName}
              </>
            ) : (
              <>
                <UserRound size={14} />
                {share.recipientEmail}
              </>
            )}
          </p>
        </div>
        <span className={`internal-status ${active ? "active" : ""}`}>
          {share.disabledAt ? "取り消し済み" : active ? "共有中" : "期限切れ"}
        </span>
      </div>
      <dl className="internal-details">
        <div>
          <dt>有効期限</dt>
          <dd>{share.expiresAt ? date(share.expiresAt) : "—"}</dd>
        </div>
        <div>
          <dt>許可</dt>
          <dd>{download ? "閲覧・ダウンロード" : "閲覧のみ"}</dd>
        </div>
        <div>
          <dt>共有 ID</dt>
          <dd>{share.id}</dd>
        </div>
        {share.sourceShareId && (
          <>
            <div>
              <dt>委任深度</dt>
              <dd>{share.delegationDepth}</dd>
            </div>
            <div>
              <dt>共有元 ID</dt>
              <dd>{share.sourceShareId}</dd>
            </div>
            <div>
              <dt>委任者 ID</dt>
              <dd>{share.delegatedByUserId ?? "—"}</dd>
            </div>
          </>
        )}
      </dl>
      <PolicySummary share={share} />
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      {active && (
        <div className="internal-card-actions">
          {!share.sourceShareId && (
            <Button size="small" disabled={pending} onClick={() => editPolicy(share)}>
              <ShieldCheck size={15} />
              再共有ポリシーを編集
            </Button>
          )}
          <Button size="small" disabled={pending} onClick={() => void changeDownload()}>
            {pending ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            ダウンロードを{download ? "停止" : "許可"}
          </Button>
          <Button size="small" variant="danger" disabled={pending} onClick={() => revoke(share)}>
            <Trash2 size={15} />
            共有を取り消す
          </Button>
        </div>
      )}
    </article>
  );
}

function SharedMountCard({ mount }: { mount: SharedMount }) {
  return (
    <article className="internal-card internal-mount-card">
      <div className="internal-card-heading">
        <span className="internal-card-icon received">
          <FolderOpen size={20} />
        </span>
        <div>
          <h3>{mount.root.name}</h3>
          <p>{mount.owner.email} から共有</p>
        </div>
        <span className="internal-status active">利用可能</span>
      </div>
      <dl className="internal-details">
        <div>
          <dt>共有経路</dt>
          <dd>
            {mount.provenance.kind === "group" ? (
              <>
                <UsersRound size={14} />
                {mount.provenance.groupName}
              </>
            ) : (
              <>
                <UserRound size={14} />
                あなたに直接
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>有効な操作</dt>
          <dd>{mount.actions.includes("download") ? "閲覧・ダウンロード" : "閲覧のみ"}</dd>
        </div>
        <div>
          <dt>マウント名</dt>
          <dd>{mount.mountName}</dd>
        </div>
      </dl>
      <div className="internal-card-actions">
        <Button asChild variant="primary" size="small">
          <Link to="/shared/$shareId" params={{ shareId: mount.shareId }}>
            <FolderOpen size={15} />
            共有フォルダーを開く
          </Link>
        </Button>
      </div>
    </article>
  );
}

export function InternalShares({ account }: { account: Account }) {
  const query = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<InternalShare | null>(null);
  const [revoking, setRevoking] = useState<InternalShare | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeFailure, setRevokeFailure] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const previousMounts = useRef<Map<string, SharedMount> | null>(null);
  const owned = useQuery({
    queryKey: ["shares", account.id, account.epoch],
    queryFn: ({ signal }) => api.shares(signal),
  });
  const groups = useQuery({
    queryKey: ["share-groups", account.id, account.epoch],
    queryFn: ({ signal }) => api.groups(signal),
  });
  const received = useQuery({
    queryKey: ["shared-with-me", account.id, account.epoch],
    queryFn: ({ signal }) => api.sharedWithMe(signal),
  });
  useEffect(() => {
    previousMounts.current = null;
    setAccessNotice("");
  }, [account.id, account.epoch]);
  useEffect(() => {
    if (!received.data) return;
    const current = new Map(received.data.shares.map((mount) => [mount.shareId, mount]));
    const previous = previousMounts.current;
    if (previous) {
      const removed = [...previous.values()].filter((mount) => !current.has(mount.shareId));
      if (removed.length)
        setAccessNotice(
          `${removed.map((mount) => mount.root.name).join("、")} へのアクセスが変更されました。共有の取り消し、期限切れ、またはグループ所属の変更が考えられます。`,
        );
    }
    previousMounts.current = current;
  }, [received.data]);
  const internal = (owned.data?.shares ?? []).filter(
    (share): share is InternalShare => share.kind === "internal",
  );
  const mounts = received.data?.shares ?? [];
  const activeOwned = internal.filter(
    (share) =>
      share.disabledAt === null && (share.expiresAt === null || share.expiresAt > Date.now()),
  ).length;
  const refresh = () => {
    void owned.refetch();
    void groups.refetch();
    void received.refetch();
  };
  const revoke = async () => {
    if (!revoking) return;
    setRevokePending(true);
    setRevokeFailure("");
    try {
      await api.disableShare(revoking.id);
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
      setRevoking(null);
    } catch (error) {
      setRevokeFailure(errorMessage(error));
    } finally {
      setRevokePending(false);
    }
  };
  return (
    <div className="internal-shares">
      <div className="internal-share-toolbar">
        <div>
          <strong>{activeOwned}</strong> 件の有効な作成済み共有 · <strong>{mounts.length}</strong>{" "}
          件の受信共有
        </div>
        <div>
          <Button variant="ghost" size="icon" aria-label="内部共有を更新" onClick={refresh}>
            <RefreshCw
              size={17}
              className={owned.isFetching || received.isFetching ? "spin" : ""}
            />
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Share2 size={16} />
            内部共有を作成
          </Button>
        </div>
      </div>
      {accessNotice && (
        <div className="notice" role="status">
          <span>{accessNotice}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="通知を閉じる"
            onClick={() => setAccessNotice("")}
          >
            ×
          </Button>
        </div>
      )}
      <section className="internal-section" aria-labelledby="received-shares-heading">
        <div className="internal-section-heading">
          <div>
            <p className="eyebrow">SHARED WITH YOU</p>
            <h2 id="received-shares-heading">共有されたフォルダー</h2>
          </div>
          <p>表示中の操作だけが、サーバーで現在許可されている操作です。</p>
        </div>
        {received.error ? (
          <div className="internal-panel-error" role="alert">
            <p>{errorMessage(received.error)}</p>
            <Button size="small" onClick={() => void received.refetch()}>
              再試行
            </Button>
          </div>
        ) : received.isPending ? (
          <div className="internal-panel-loading">
            <LoaderCircle className="spin" size={22} />
            受信共有を読み込んでいます
          </div>
        ) : mounts.length ? (
          <div className="internal-card-grid">
            {mounts.map((mount) => (
              <SharedMountCard key={`${mount.shareId}:${mount.shareVersion}`} mount={mount} />
            ))}
          </div>
        ) : (
          <div className="internal-panel-empty">
            <FolderOpen size={31} />
            <h3>共有されたフォルダーはありません</h3>
            <p>現在有効な直接共有とグループ共有が、ここに表示されます。</p>
          </div>
        )}
      </section>
      <section className="internal-section" aria-labelledby="owned-shares-heading">
        <div className="internal-section-heading">
          <div>
            <p className="eyebrow">SHARED BY YOU</p>
            <h2 id="owned-shares-heading">自分が共有したフォルダー</h2>
          </div>
          <p>公開リンクとは分離され、相手のログイン状態と現在の権限で評価されます。</p>
        </div>
        {owned.error ? (
          <div className="internal-panel-error" role="alert">
            <p>{errorMessage(owned.error)}</p>
            <Button size="small" onClick={() => void owned.refetch()}>
              再試行
            </Button>
          </div>
        ) : owned.isPending ? (
          <div className="internal-panel-loading">
            <LoaderCircle className="spin" size={22} />
            作成済み共有を読み込んでいます
          </div>
        ) : internal.length ? (
          <div className="internal-card-grid">
            {internal.map((share) => (
              <OwnedShareCard
                key={`${share.id}:${share.version}:${share.disabledAt ?? "active"}`}
                account={account}
                share={share}
                revoke={setRevoking}
                editPolicy={setEditingPolicy}
              />
            ))}
          </div>
        ) : (
          <div className="internal-panel-empty">
            <Share2 size={31} />
            <h3>内部共有はまだありません</h3>
            <p>フォルダーと共有相手を選び、読み取り専用の共有を作成できます。</p>
          </div>
        )}
      </section>
      {creating && (
        <CreateInternalShareDialog
          account={account}
          groups={groups.data?.groups ?? []}
          groupsPending={groups.isPending}
          groupsError={groups.error}
          retryGroups={() => void groups.refetch()}
          close={() => setCreating(false)}
        />
      )}
      {!!editingPolicy && (
        <ResharePolicyDialog
          account={account}
          share={editingPolicy}
          close={() => setEditingPolicy(null)}
        />
      )}
      {!!revoking && (
        <Dialog
          title="内部共有を取り消しますか"
          description={`${revoking.rootName ?? revoking.mountName ?? "この共有"} は相手の共有一覧から外れ、開いている操作もサーバー側で再評価されます。`}
          open
          onOpenChange={(open) => {
            if (!open && !revokePending) setRevoking(null);
          }}
        >
          {revokeFailure && (
            <p className="form-error" role="alert">
              {revokeFailure}
            </p>
          )}
          <div className="dialog-actions">
            <Button variant="ghost" disabled={revokePending} onClick={() => setRevoking(null)}>
              閉じる
            </Button>
            <Button variant="danger" disabled={revokePending} onClick={() => void revoke()}>
              {revokePending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              共有を取り消す
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
