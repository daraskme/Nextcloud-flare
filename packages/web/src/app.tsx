import * as Menu from "@radix-ui/react-dropdown-menu";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Images,
  Info,
  LayoutGrid,
  List,
  LoaderCircle,
  LogOut,
  Menu as MenuIcon,
  MoreHorizontal,
  Music2,
  PlaySquare,
  RefreshCw,
  Search,
  Share2,
  Star,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { PrivateAudio } from "./features/audio/PrivateAudio";
import { FolderStatsDialog } from "./features/files/FolderStatsDialog";
import { PrivateGallery } from "./features/gallery/PrivateGallery";
import { PrivateBookshelf } from "./features/library/PrivateBookshelf";
import { InternalShares } from "./features/shares/InternalShares";
import { type UploadTask, uploads } from "./features/uploads/manager";
import { OverwriteDialog } from "./features/uploads/OverwriteDialog";
import { PrivateVideo } from "./features/video/PrivateVideo";
import {
  type Account,
  ApiError,
  api,
  errorMessage,
  type FileNode,
  formatBytes,
  type TrashItem,
} from "./lib/api";

type Action =
  | { kind: "create" }
  | { kind: "rename" | "move" | "copy" | "trash"; node: FileNode }
  | { kind: "share"; node: Pick<FileNode, "id" | "name" | "kind"> }
  | { kind: "overwrite"; node: FileNode }
  | { kind: "restore" | "purge"; item: TrashItem };
type Pending = {
  accountId: string;
  epoch: number;
  path: string;
  method: string;
  body: Record<string, unknown>;
  key: string;
};
const PENDING_KEY = "ncf-pending-operation";
const time = (value: number) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);

function FileIcon({ node }: { node: Pick<FileNode, "kind" | "name" | "mime"> }) {
  const extension = node.name.split(".").at(-1)?.toLowerCase();
  const type =
    node.kind === "folder"
      ? "folder"
      : node.mime?.startsWith("image/") || ["avif", "jpg", "png", "webp"].includes(extension ?? "")
        ? "image"
        : node.mime?.startsWith("audio/") ||
            ["opus", "ogg", "mp3", "flac"].includes(extension ?? "")
          ? "audio"
          : node.mime?.startsWith("video/") || ["mp4", "webm"].includes(extension ?? "")
            ? "video"
            : ["pdf", "txt", "md", "epub"].includes(extension ?? "")
              ? "text"
              : "file";
  const Icon = {
    folder: Folder,
    image: FileImage,
    audio: FileAudio,
    video: FileVideo,
    text: FileText,
    file: File,
  }[type];
  return (
    <span className={`file-icon file-icon-${type}`}>
      <Icon aria-hidden="true" size={22} strokeWidth={1.7} />
    </span>
  );
}

function UploadPanel() {
  const tasks = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const [collapsed, collapse] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef<UploadTask | null>(null);
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.phase === "completed").length;
  return (
    <section className="upload-panel" aria-label="アップロード状況">
      <div className="upload-panel-heading">
        <button onClick={() => collapse(!collapsed)} aria-expanded={!collapsed}>
          <Upload size={18} />
          アップロード{" "}
          <span>
            {done} / {tasks.length}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          title="完了した項目を閉じる"
          aria-label="完了した項目を閉じる"
          onClick={() => uploads.dismiss()}
        >
          <X size={16} />
        </Button>
      </div>
      {!collapsed && (
        <div className="upload-tasks">
          {tasks.map((task) => (
            <div className="upload-task" key={task.record.localId}>
              <div className="upload-task-title">
                <File size={17} />
                <strong title={task.record.name}>{task.record.name}</strong>
                {task.phase === "completed" ? (
                  <Check className="success" size={18} />
                ) : (
                  !["cancelled"].includes(task.phase) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${task.record.name}を中止`}
                      onClick={() => {
                        void uploads.cancel(task);
                      }}
                    >
                      <X size={16} />
                    </Button>
                  )
                )}
              </div>
              <progress
                max={Math.max(1, task.record.size)}
                value={task.bytes}
                aria-label={`${task.record.name}の進捗`}
              />
              <div className="upload-task-meta">
                <span>{task.message}</span>
                <span>
                  {formatBytes(task.bytes)} / {formatBytes(task.record.size)}
                </span>
              </div>
              {task.phase === "paused" && (
                <Button
                  size="small"
                  onClick={() => {
                    selected.current = task;
                    input.current?.click();
                  }}
                >
                  元のファイルを選択・再確認
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && selected.current) void uploads.resume(selected.current, file);
          event.target.value = "";
        }}
      />
    </section>
  );
}

function FolderPicker({
  account,
  value,
  onChange,
  exclude,
}: {
  account: Account;
  value: string;
  onChange: (id: string) => void;
  exclude?: string;
}) {
  const listing = useInfiniteQuery({
    queryKey: ["picker", account.id, account.epoch, value],
    queryFn: ({ pageParam, signal }) => api.children(value, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const path = useQuery({
    queryKey: ["path", account.id, account.epoch, value],
    queryFn: ({ signal }) => api.path(value, signal),
  });
  const folders =
    listing.data?.pages
      .flatMap((page) => page.children)
      .filter((node) => node.kind === "folder" && node.id !== exclude) ?? [];
  return (
    <div className="folder-picker">
      <div className="picker-path">
        <Folder size={16} />
        {path.data?.path.at(-1)?.name || "マイドライブ"}
        {value !== account.rootNodeId && (
          <Button
            size="small"
            variant="ghost"
            onClick={() => onChange(path.data?.path.at(-2)?.id ?? account.rootNodeId)}
          >
            <ArrowLeft size={14} />
            上の階層
          </Button>
        )}
      </div>
      <div className="picker-list">
        {folders.map((folder) => (
          <button type="button" key={folder.id} onClick={() => onChange(folder.id)}>
            <Folder size={17} />
            <span>{folder.name}</span>
            <ChevronRight size={16} />
          </button>
        ))}
        {!folders.length && !listing.isPending && <p>この場所にサブフォルダーはありません</p>}
        {listing.isPending && <p>読み込み中…</p>}
      </div>
      {listing.error && (
        <p role="alert" className="form-error">
          {errorMessage(listing.error)}
        </p>
      )}
      {listing.hasNextPage && (
        <Button
          type="button"
          size="small"
          disabled={listing.isFetchingNextPage}
          onClick={() => {
            void listing.fetchNextPage();
          }}
        >
          さらに読み込む
        </Button>
      )}
    </div>
  );
}

function OperationDialog({
  action,
  account,
  parentId,
  onClose,
  refresh,
}: {
  action: Exclude<Action, { kind: "overwrite" | "share" }>;
  account: Account;
  parentId: string;
  onClose: () => void;
  refresh: () => void;
}) {
  const [name, setName] = useState("node" in action ? action.node.name : "");
  const [destination, setDestination] = useState(account.rootNodeId);
  const [key, setKey] = useState(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [confirmed, confirm] = useState(false);
  const titles = {
    create: "新しいフォルダー",
    rename: "名前を変更",
    move: "移動先を選択",
    copy: "コピー先を選択",
    trash: "ごみ箱に移動",
    restore: "復元先を選択",
    purge: "完全に削除",
  };
  const title = titles[action.kind];
  const destructive = action.kind === "purge";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure("");
    let path = "/api/v1/nodes",
      method = "POST",
      body: Record<string, unknown> = { spaceId: account.spaceId };
    if (action.kind === "create") body = { ...body, kind: "folder", parentId, name };
    else if ("node" in action) {
      path += `/${encodeURIComponent(action.node.id)}`;
      if (action.kind === "rename") {
        method = "PATCH";
        body.name = name;
      } else if (action.kind === "trash") method = "DELETE";
      else {
        path += `/${action.kind}`;
        body = {
          ...body,
          destinationParentId: destination,
          name,
          ...(action.kind === "copy" ? { depth: "infinity" } : {}),
        };
      }
    } else {
      path = `/api/v1/trash/${encodeURIComponent(action.item.opId)}/${action.kind}`;
      if (action.kind === "restore") body.destinationParentId = destination;
    }
    const intent: Pending = {
      accountId: account.id,
      epoch: account.epoch,
      path,
      method,
      body,
      key,
    };
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
      await api.mutation(path, method, body, key);
      sessionStorage.removeItem(PENDING_KEY);
      refresh();
      onClose();
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      setUncertain(unknown);
      if (!unknown) sessionStorage.removeItem(PENDING_KEY);
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const description = destructive
    ? `「${"item" in action ? action.item.name : ""}」を完全に削除します。この操作は取り消せません。`
    : action.kind === "trash"
      ? `「${"node" in action ? action.node.name : ""}」を移動します。ごみ箱から復元できます。`
      : ["move", "copy", "restore"].includes(action.kind)
        ? "下のフォルダーを開いて保存先を選んでください。"
        : "ファイルを整理するための名前を入力してください。";
  return (
    <Dialog
      open
      title={title}
      description={description}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {["create", "rename", "move", "copy"].includes(action.kind) && (
          <label className="field-label">
            名前
            <input
              autoFocus
              required
              maxLength={255}
              value={name}
              disabled={pending || uncertain}
              onChange={(event) => {
                setName(event.target.value);
                setKey(crypto.randomUUID());
              }}
              placeholder="フォルダー名"
            />
          </label>
        )}
        {["move", "copy", "restore"].includes(action.kind) && (
          <fieldset disabled={pending || uncertain}>
            <legend className="field-label">保存先</legend>
            <FolderPicker
              account={account}
              value={destination}
              onChange={(id) => {
                setDestination(id);
                setKey(crypto.randomUUID());
              }}
              {...("node" in action ? { exclude: action.node.id } : {})}
            />
          </fieldset>
        )}
        {destructive && (
          <label className="confirm-delete">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => confirm(event.target.checked)}
            />
            完全に削除することを確認しました
          </label>
        )}
        {failure && (
          <p role="alert" className="form-error">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            閉じる
          </Button>
          <Button
            type="submit"
            variant={destructive ? "danger" : "primary"}
            disabled={pending || (destructive && !confirmed)}
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : null}
            {uncertain ? "同じ操作の結果を確認" : title}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ShareDialog({
  node,
  account,
  onClose,
}: {
  node: Pick<FileNode, "id" | "name" | "kind">;
  account: Account;
  onClose: () => void;
}) {
  const query = useQueryClient();
  const existing = useQuery({
    queryKey: ["shares", account.id, account.epoch],
    queryFn: ({ signal }) => api.shares(signal),
    retry: false,
  });
  const [ttlDays, setTtlDays] = useState(30);
  const [shareKind, setShareKind] = useState<"link" | "upload_only">("link");
  const [reservationLimitGiB, setReservationLimitGiB] = useState(10);
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<{
    id: string;
    url: string;
    passwordProtected: boolean;
    kind: "link" | "upload_only";
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const activeShares =
    existing.data?.shares.filter(
      (share) =>
        share.rootNodeId === node.id &&
        share.disabledAt === null &&
        (share.expiresAt === null || share.expiresAt > Date.now()),
    ) ?? [];
  const activeCount = activeShares.length;
  const protectedCount = activeShares.filter((share) => share.passwordProtected).length;
  const create = async () => {
    setPending(true);
    setFailure("");
    try {
      const share = await api.createShare(
        node.id,
        account.spaceId,
        ttlDays,
        shareKind,
        password || undefined,
        shareKind === "upload_only" ? reservationLimitGiB * 1024 ** 3 : undefined,
      );
      setCreated({
        id: share.id,
        url: share.shareUrl,
        passwordProtected: share.passwordProtected,
        kind: share.kind,
      });
      setPassword("");
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const disable = async () => {
    if (!created) return;
    setPending(true);
    setFailure("");
    try {
      await api.disableShare(created.id);
      setCreated(null);
      setPassword("");
      setCopied(false);
      await query.invalidateQueries({ queryKey: ["shares", account.id, account.epoch] });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="共有リンク"
      description={
        shareKind === "upload_only"
          ? `「${node.name}」でファイルを受け取るリンクを作成します。`
          : `「${node.name}」をリンクを知っている人に閲覧専用で共有します。`
      }
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      {created ? (
        <div className="share-result">
          <label className="field-label">
            共有URL
            <input readOnly value={created.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <p>
            URLは安全のため、この画面を閉じると再表示できません。
            {created.passwordProtected ? "利用時には設定したパスワードも必要です。" : ""}
          </p>
          <p>
            {created.kind === "upload_only"
              ? "受け取り側にはフォルダー内容や保存後のファイル名を表示しません。"
              : "閲覧者は共有された項目を読み取り専用で確認できます。"}
          </p>
          <div className="dialog-actions">
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => void disable()}
            >
              共有を停止
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.url);
                  setCopied(true);
                } catch {
                  setFailure("URLをコピーできませんでした。入力欄からコピーしてください。");
                }
              }}
            >
              {copied ? "コピーしました" : "URLをコピー"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="share-create">
          {activeCount > 0 && (
            <p className="notice">
              この項目には有効な共有リンクが {activeCount} 件あります。秘密部分は再表示できません。
              {protectedCount > 0 ? ` パスワード保護: ${protectedCount}件。` : ""}
            </p>
          )}
          <label className="field-label">
            共有方法
            <select
              value={shareKind}
              disabled={pending}
              onChange={(event) => setShareKind(event.target.value as "link" | "upload_only")}
            >
              <option value="link">閲覧専用リンク</option>
              {node.kind !== "file" && <option value="upload_only">ファイル受け取りリンク</option>}
            </select>
          </label>
          <label className="field-label">
            有効期間
            <select
              value={ttlDays}
              disabled={pending}
              onChange={(event) => setTtlDays(Number(event.target.value))}
            >
              <option value={7}>7日</option>
              <option value={30}>30日</option>
              <option value={90}>90日</option>
              <option value={365}>365日</option>
            </select>
          </label>
          {shareKind === "upload_only" && (
            <label className="field-label">
              受け取り予約上限
              <select
                value={reservationLimitGiB}
                disabled={pending}
                onChange={(event) => setReservationLimitGiB(Number(event.target.value))}
              >
                <option value={1}>1 GB</option>
                <option value={10}>10 GB</option>
                <option value={50}>50 GB</option>
                <option value={100}>100 GB</option>
              </select>
            </label>
          )}
          <label className="field-label">
            パスワード（任意）
            <input
              type="password"
              value={password}
              disabled={pending}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p>設定したパスワードは再表示できません。リンクとは別の方法で共有してください。</p>
          <p>
            {shareKind === "upload_only"
              ? "受け取り側は新しいファイルの送信だけができ、一覧表示・閲覧・上書き・削除はできません。"
              : "閲覧者はフォルダーとファイル名を確認できます。アップロードや変更はできません。"}
          </p>
          <div className="dialog-actions">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              閉じる
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending}
              onClick={() => void create()}
            >
              {pending ? <LoaderCircle className="spin" size={16} /> : <Share2 size={16} />}
              リンクを作成
            </Button>
          </div>
        </div>
      )}
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
    </Dialog>
  );
}

function NodeMenu({
  node,
  act,
  open,
}: {
  node: FileNode;
  act: (action: Action) => void;
  open: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${node.name}の操作`}>
          <MoreHorizontal size={18} />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="context-menu" align="end" sideOffset={4}>
          <Menu.Item onSelect={open}>
            {node.kind === "folder" ? "開く" : "ファイルを開く・保存"}
          </Menu.Item>
          {node.parentId && (
            <Menu.Item asChild>
              <Link to="/files/$folderId" params={{ folderId: node.parentId }}>
                保存場所を開く
              </Link>
            </Menu.Item>
          )}
          {node.kind === "file" && (
            <Menu.Item onSelect={() => act({ kind: "overwrite", node })}>
              ファイルを上書き
            </Menu.Item>
          )}
          <Menu.Item onSelect={() => act({ kind: "rename", node })}>名前を変更</Menu.Item>
          <Menu.Item onSelect={() => act({ kind: "move", node })}>移動</Menu.Item>
          <Menu.Item onSelect={() => act({ kind: "copy", node })}>コピー</Menu.Item>
          <Menu.Item onSelect={() => act({ kind: "share", node })}>共有リンク</Menu.Item>
          <Menu.Separator />
          <Menu.Item className="danger-text" onSelect={() => act({ kind: "trash", node })}>
            ごみ箱に移動
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function FileList({
  rows,
  view,
  act,
  open,
  readOnly = false,
  currentUserId,
  toggleStar,
  starPending,
}: {
  rows: FileNode[];
  view: "list" | "grid";
  act: (action: Action) => void;
  open: (node: FileNode) => void;
  readOnly?: boolean;
  currentUserId: string;
  toggleStar: (node: FileNode) => void;
  starPending: ReadonlySet<string>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 66,
    overscan: 8,
    getItemKey: (index) => rows[index]!.id,
  });
  if (view === "grid")
    return (
      <div className="file-grid">
        {rows.map((node) => (
          <article key={node.id} className="file-card">
            <div className="file-card-top">
              <FileIcon node={node} />
              <div className="file-card-actions">
                <Button
                  variant="ghost"
                  size="icon"
                  className="star-control"
                  aria-label={`${node.name}を${node.starred ? "スターから外す" : "スターに追加"}`}
                  aria-pressed={!!node.starred}
                  disabled={starPending.has(node.id)}
                  onClick={() => toggleStar(node)}
                >
                  <Star size={17} fill={node.starred ? "currentColor" : "none"} />
                </Button>
                {!readOnly && (!node.ownerId || node.ownerId === currentUserId) && (
                  <NodeMenu node={node} act={act} open={() => open(node)} />
                )}
              </div>
            </div>
            <button className="file-name" onClick={() => open(node)} title={node.name}>
              {node.name}
            </button>
            <p>
              {node.kind === "folder" ? "フォルダー" : formatBytes(node.size)}
              <span>{new Date(node.updatedAt).toLocaleDateString("ja-JP")}</span>
            </p>
          </article>
        ))}
      </div>
    );
  return (
    <div
      className="file-table"
      role="table"
      aria-label="ファイル一覧"
      aria-rowcount={rows.length + 1}
    >
      <div className="file-table-head file-row" role="row">
        <div role="columnheader">名前</div>
        <div role="columnheader">更新日時</div>
        <div role="columnheader">サイズ</div>
        <div role="columnheader">
          <span className="sr-only">操作</span>
        </div>
      </div>
      <div
        ref={scroller}
        className="file-scroll"
        tabIndex={0}
        aria-label="ファイル一覧をスクロール"
        role="rowgroup"
      >
        <div style={{ height: `${virtual.getTotalSize()}px`, position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const node = rows[item.index]!;
            return (
              <div
                key={node.id}
                role="row"
                aria-rowindex={item.index + 2}
                className="file-row file-data-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <div role="cell" className="name-cell">
                  <FileIcon node={node} />
                  <button className="file-name" title={node.name} onClick={() => open(node)}>
                    {node.name}
                    <small>{node.kind === "folder" ? "フォルダー" : "ファイル"}</small>
                  </button>
                </div>
                <div role="cell" className="date-cell">
                  {time(node.updatedAt)}
                </div>
                <div role="cell" className="size-cell">
                  {node.kind === "folder" ? "—" : formatBytes(node.size)}
                </div>
                <div role="cell">
                  <div className="file-actions">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="star-control"
                      aria-label={`${node.name}を${node.starred ? "スターから外す" : "スターに追加"}`}
                      aria-pressed={!!node.starred}
                      disabled={starPending.has(node.id)}
                      onClick={() => toggleStar(node)}
                    >
                      <Star size={17} fill={node.starred ? "currentColor" : "none"} />
                    </Button>
                    {!readOnly && (!node.ownerId || node.ownerId === currentUserId) && (
                      <NodeMenu node={node} act={act} open={() => open(node)} />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const query = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const account = useQuery({
    queryKey: ["account"],
    queryFn: ({ signal }) => api.me(signal),
    retry: false,
    staleTime: 60_000,
  });
  const authExpired =
    account.error instanceof ApiError && [401, 403].includes(account.error.status);
  const me = authExpired ? undefined : account.data;
  const trash = pathname === "/trash";
  const recent = pathname === "/recent";
  const starred = pathname === "/starred";
  const gallery = pathname === "/gallery";
  const audio = pathname === "/audio";
  const bookshelf = pathname === "/bookshelf";
  const video = pathname === "/video";
  const sharing = pathname === "/shares";
  const sharedMatch = /^\/shared\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  const shared = !!sharedMatch;
  const userState = recent || starred;
  const files =
    !trash && !recent && !starred && !gallery && !audio && !bookshelf && !video && !sharing;
  const personalFiles = files && !shared;
  const sharedMounts = useQuery({
    queryKey: ["shared-with-me", me?.id, me?.epoch],
    queryFn: ({ signal }) => api.sharedWithMe(signal),
    enabled: !!me && shared,
    retry: false,
  });
  const sharedMount = sharedMounts.data?.shares.find((mount) => mount.shareId === sharedMatch?.[1]);
  const parentId = shared
    ? (sharedMatch?.[2] ?? sharedMount?.root.id ?? "")
    : (/^\/files\/([^/]+)$/.exec(pathname)?.[1] ?? me?.rootNodeId ?? "");
  const mountAccessVersion =
    sharedMount?.provenance.kind === "group"
      ? sharedMount.provenance.membershipVersion
      : sharedMount?.provenance.recipientVersion;
  const [view, setView] = useState<"list" | "grid">("list");
  const [filter, setFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState<{ scopeId: string; query: string } | null>(null);
  const searching = files && searchTerm?.scopeId === parentId && !!searchTerm.query;
  const [action, setAction] = useState<Action | null>(null);
  const [statsScope, setStatsScope] = useState<string | null>(null);
  useEffect(() => setStatsScope(null), [pathname]);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [recovery, setRecovery] = useState<Pending | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [starPending, setStarPending] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const listing = useInfiniteQuery({
    queryKey: [
      "children",
      me?.id,
      me?.epoch,
      parentId,
      sharedMount?.shareVersion,
      mountAccessVersion,
    ],
    queryFn: ({ pageParam, signal }) => api.children(parentId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!me && files && !!parentId && (!shared || !!sharedMount) && !searching,
    retry: false,
  });
  const results = useInfiniteQuery({
    queryKey: [
      "search",
      me?.id,
      me?.epoch,
      parentId,
      searchTerm?.query,
      sharedMount?.shareVersion,
      mountAccessVersion,
    ],
    queryFn: ({ pageParam, signal }) => api.search(parentId, searchTerm!.query, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!me && files && !!parentId && (!shared || !!sharedMount) && searching,
    retry: false,
  });
  const path = useQuery({
    queryKey: ["path", me?.id, me?.epoch, parentId, sharedMount?.shareVersion, mountAccessVersion],
    queryFn: ({ signal }) => api.path(parentId, signal),
    enabled: !!me && files && !!parentId && (!shared || !!sharedMount),
    retry: false,
  });
  const trashed = useInfiniteQuery({
    queryKey: ["trash", me?.id, me?.epoch],
    queryFn: ({ pageParam, signal }) => api.trash(me!.spaceId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!me && trash,
    retry: false,
  });
  const userNodes = useInfiniteQuery({
    queryKey: ["user-nodes", me?.id, me?.epoch, recent ? "recent" : "starred"],
    queryFn: ({ pageParam, signal }) =>
      api.userNodes(recent ? "recent" : "starred", pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!me && userState,
    retry: false,
  });
  const refresh = () => {
    for (const key of [
      "children",
      "trash",
      "path",
      "picker",
      "search",
      "stats",
      "shared-with-me",
      "shares",
      "share-groups",
      "user-nodes",
    ])
      void query.resetQueries({ queryKey: [key] });
    void query.invalidateQueries({ queryKey: ["account"] });
  };
  useEffect(() => {
    uploads.onCompleted = refresh;
  }, [query]);
  useEffect(() => {
    if (authExpired) {
      api.clear();
      void uploads.clear();
      sessionStorage.removeItem(PENDING_KEY);
      setRecovery(null);
      query.removeQueries({ predicate: (entry) => entry.queryKey[0] !== "account" });
    }
  }, [authExpired, query]);
  useEffect(() => {
    if (me) {
      void uploads
        .load(me)
        .catch(() =>
          setNotice(
            "アップロードの再開情報を保存できません。ブラウザーのストレージ設定を確認してください。",
          ),
        );
      try {
        const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
        if (pending?.accountId === me.id && pending.epoch === me.epoch) setRecovery(pending);
        else {
          sessionStorage.removeItem(PENDING_KEY);
          setRecovery(null);
        }
      } catch {
        setRecovery(null);
        sessionStorage.removeItem(PENDING_KEY);
      }
    }
  }, [me?.id, me?.epoch]);
  useEffect(() => {
    setFilter("");
    setSearchTerm(null);
    setSidebar(false);
    setAction(null);
  }, [pathname]);
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (uploads.active) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    const bc = new BroadcastChannel("ncf-auth");
    channel.current = bc;
    bc.onmessage = (event) => {
      if (event.data === "logout") {
        api.clear();
        query.clear();
        sessionStorage.removeItem(PENDING_KEY);
        void uploads.clear().finally(() => location.assign("/cdn-cgi/access/logout"));
      }
    };
    return () => {
      window.removeEventListener("beforeunload", listener);
      bc.close();
    };
  }, [query]);
  const act = (next: Action) => {
    if (sessionStorage.getItem(PENDING_KEY)) {
      setNotice("未確認の操作があります。結果を確認してから続けてください。");
      return;
    }
    setAction(next);
  };
  const addFiles = async (selectedFiles: FileList | null) => {
    if (!selectedFiles || !me || !personalFiles) return;
    for (const file of Array.from(selectedFiles)) {
      try {
        await uploads.enqueue(file, me, parentId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "アップロードを開始できません。");
        break;
      }
    }
  };
  const recordOpen = (nodeId: string) => {
    if (!me) return;
    void api
      .recordRecent(nodeId)
      .then(() => query.invalidateQueries({ queryKey: ["user-nodes", me.id, me.epoch, "recent"] }))
      .catch(() => undefined);
  };
  const openNode = (node: FileNode) => {
    if (node.kind === "folder") {
      const navigation = sharedMount
        ? navigate({
            to: "/shared/$shareId/$folderId",
            params: { shareId: sharedMount.shareId, folderId: node.id },
          })
        : navigate({ to: "/files/$folderId", params: { folderId: node.id } });
      void navigation
        .then(() => recordOpen(node.id))
        .catch((error) => setNotice(errorMessage(error)));
      return;
    }
    if (sharedMount && !sharedMount.actions.includes("download")) {
      setNotice("この共有ではファイルのダウンロードが許可されていません。");
      return;
    }
    const target = window.open("about:blank", "_blank");
    if (!target || !me) {
      setNotice("ファイルを開くには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    void api
      .openFile(me, node, target)
      .then(() => recordOpen(node.id))
      .catch((error) => setNotice(errorMessage(error)));
  };
  const toggleStar = async (node: FileNode) => {
    if (starPending.has(node.id)) return;
    setStarPending((current) => new Set(current).add(node.id));
    try {
      await Promise.all([
        query.cancelQueries({ queryKey: ["children"] }),
        query.cancelQueries({ queryKey: ["search"] }),
        query.cancelQueries({ queryKey: ["user-nodes"] }),
      ]);
      await api.setStar(node.id, !node.starred);
      await Promise.all([
        query.invalidateQueries({ queryKey: ["children"] }),
        query.invalidateQueries({ queryKey: ["search"] }),
        query.invalidateQueries({ queryKey: ["user-nodes"] }),
      ]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setStarPending((current) => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
    }
  };
  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
      channel.current?.postMessage("logout");
      api.clear();
      query.clear();
      sessionStorage.removeItem(PENDING_KEY);
      await uploads.clear();
      location.assign("/cdn-cgi/access/logout");
    } catch (error) {
      setNotice(errorMessage(error));
      setLoggingOut(false);
    }
  };
  const rows = listing.data?.pages.flatMap((page) => page.children) ?? [];
  const items = trashed.data?.pages.flatMap((page) => page.items) ?? [];
  const stateRows = userNodes.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = (
    userState
      ? stateRows
      : searching
        ? results.error
          ? []
          : (results.data?.pages.flatMap((page) => page.items) ?? [])
        : rows
  ).filter((item) =>
    userState
      ? item.name.toLocaleLowerCase("ja-JP").includes(filter.toLocaleLowerCase("ja-JP"))
      : true,
  );
  const filteredTrash = items.filter((item) =>
    item.name.toLocaleLowerCase("ja-JP").includes(filter.toLocaleLowerCase("ja-JP")),
  );
  const data = trash ? trashed : userState ? userNodes : searching ? results : listing;
  const truncated = searching && results.data?.pages.some((page) => page.truncated);
  const sharedRootIndex = sharedMount
    ? (path.data?.path.findIndex((crumb) => crumb.id === sharedMount.root.id) ?? -1)
    : -1;
  const sharedPathInvalid = !!sharedMount && !!path.data && sharedRootIndex < 0;
  const breadcrumbPath = sharedMount
    ? sharedRootIndex >= 0
      ? path.data?.path.slice(sharedRootIndex + 1)
      : []
    : path.data?.path.slice(1);
  const title = trash
    ? "ごみ箱"
    : recent
      ? "最近使った項目"
      : starred
        ? "スター付き"
        : sharing
          ? "内部共有"
          : shared
            ? sharedMount && !sharedPathInvalid
              ? path.data?.path.at(-1)?.name || sharedMount.root.name
              : "共有フォルダー"
            : gallery
              ? "ギャラリー"
              : audio
                ? "オーディオ"
                : bookshelf
                  ? "本棚"
                  : video
                    ? "動画"
                    : path.data?.path.at(-1)?.name || "マイドライブ";
  const percent = me?.quotaBytes
    ? Math.min(100, ((me.usedBytes + me.reservedBytes) / me.quotaBytes) * 100)
    : 0;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        メインコンテンツへ移動
      </a>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="ナビゲーションを閉じる"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
        <Link to="/files" className="brand">
          <span className="brand-mark">
            <Cloud size={27} />
          </span>
          <span>
            Nextcloud<span className="brand-flare">flare</span>
          </span>
        </Link>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <nav aria-label="メインナビゲーション">
          <Link to="/files" className={personalFiles ? "nav-link active" : "nav-link"}>
            <HardDrive size={19} />
            マイドライブ
            <span className="nav-dot" />
          </Link>
          <Link to="/recent" className={recent ? "nav-link active" : "nav-link"}>
            <Clock3 size={19} />
            最近使った項目
            <span className="nav-dot" />
          </Link>
          <Link to="/starred" className={starred ? "nav-link active" : "nav-link"}>
            <Star size={19} />
            スター付き
            <span className="nav-dot" />
          </Link>
          <Link to="/shares" className={sharing || shared ? "nav-link active" : "nav-link"}>
            <UsersRound size={19} />
            内部共有
            <span className="nav-dot" />
          </Link>
          <Link to="/gallery" className={gallery ? "nav-link active" : "nav-link"}>
            <Images size={19} />
            ギャラリー
            <span className="nav-dot" />
          </Link>
          <Link to="/audio" className={audio ? "nav-link active" : "nav-link"}>
            <Music2 size={19} />
            オーディオ
            <span className="nav-dot" />
          </Link>
          <Link to="/bookshelf" className={bookshelf ? "nav-link active" : "nav-link"}>
            <BookOpen size={19} />
            本棚
            <span className="nav-dot" />
          </Link>
          <Link to="/video" className={video ? "nav-link active" : "nav-link"}>
            <PlaySquare size={19} />
            動画
            <span className="nav-dot" />
          </Link>
          <Link to="/trash" className={trash ? "nav-link active" : "nav-link"}>
            <Trash2 size={19} />
            ごみ箱
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <section className="storage-card" aria-label="ストレージ使用状況">
            <div>
              <HardDrive size={16} />
              <strong>ストレージ</strong>
            </div>
            <progress value={percent} max={100} />
            <p>
              <strong>{formatBytes(me?.usedBytes ?? 0)}</strong> /{" "}
              {formatBytes(me?.quotaBytes ?? 0)}
            </p>
            {!!me?.reservedBytes && (
              <small>{formatBytes(me.reservedBytes)} をアップロード用に予約中</small>
            )}
          </section>
          <div className="sidebar-note">
            <span className="online-dot" />
            自分だけのクラウドストレージ
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <Button
            variant="ghost"
            size="icon"
            className="mobile-menu"
            aria-label="ナビゲーションを開く"
            onClick={() => setSidebar(true)}
          >
            <MenuIcon size={21} />
          </Button>
          <div className="topbar-location">
            <span className="workspace-avatar">
              <Cloud size={17} />
            </span>
            <span>{sharing || shared ? "内部共有" : "パーソナルスペース"}</span>
            <ChevronRight size={14} />
            <span className="muted">{title}</span>
          </div>
          <div className="account-menu">
            <span className="account-email">{me?.email}</span>
            <Menu.Root>
              <Menu.Trigger asChild>
                <button className="avatar" aria-label="アカウントメニュー">
                  {me?.email.slice(0, 1).toUpperCase() || "…"}
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="context-menu" align="end">
                  <Menu.Label>{me?.email ?? "未接続"}</Menu.Label>
                  <Menu.Separator />
                  <Menu.Item
                    disabled={loggingOut || !me}
                    onSelect={() => {
                      void logout();
                    }}
                  >
                    <LogOut size={15} />
                    ログアウト
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </header>
        <main
          id="main-content"
          className={dragging ? "main dragging" : "main"}
          onDragOver={(event) => {
            if (personalFiles && event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void addFiles(event.dataTransfer.files);
          }}
        >
          {dragging && (
            <div className="drop-zone">
              <Upload size={36} />
              <strong>ここにファイルをドロップ</strong>
              <span>{title}にアップロードします</span>
            </div>
          )}
          <div className="breadcrumbs" aria-label="パンくず">
            {personalFiles ? (
              <Link to="/files">マイドライブ</Link>
            ) : shared ? (
              <Link to="/shares">内部共有</Link>
            ) : (
              <span>パーソナルスペース</span>
            )}
            {sharing && (
              <span>
                <ChevronRight size={13} />
                内部共有
              </span>
            )}
            {shared && sharedMount && (
              <span>
                <ChevronRight size={13} />
                <Link to="/shared/$shareId" params={{ shareId: sharedMount.shareId }}>
                  {sharedMount.root.name}
                </Link>
              </span>
            )}
            {files &&
              breadcrumbPath?.map((crumb) => (
                <span key={crumb.id}>
                  <ChevronRight size={13} />
                  {sharedMount ? (
                    <Link
                      to="/shared/$shareId/$folderId"
                      params={{ shareId: sharedMount.shareId, folderId: crumb.id }}
                    >
                      {crumb.name}
                    </Link>
                  ) : (
                    <Link to="/files/$folderId" params={{ folderId: crumb.id }}>
                      {crumb.name}
                    </Link>
                  )}
                </span>
              ))}
            {trash && (
              <span>
                <ChevronRight size={13} />
                ごみ箱
              </span>
            )}
            {recent && (
              <span>
                <ChevronRight size={13} />
                最近使った項目
              </span>
            )}
            {starred && (
              <span>
                <ChevronRight size={13} />
                スター付き
              </span>
            )}
            {gallery && (
              <span>
                <ChevronRight size={13} />
                ギャラリー
              </span>
            )}
            {audio && (
              <span>
                <ChevronRight size={13} />
                オーディオ
              </span>
            )}
            {bookshelf && (
              <span>
                <ChevronRight size={13} />
                本棚
              </span>
            )}
            {video && (
              <span>
                <ChevronRight size={13} />
                動画
              </span>
            )}
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {trash
                  ? "TRASH"
                  : recent
                    ? "RECENT"
                    : starred
                      ? "STARRED"
                      : sharing
                        ? "PRIVATE SHARING"
                        : shared
                          ? "SHARED FOLDER"
                          : gallery
                            ? "YOUR PHOTOS"
                            : audio
                              ? "YOUR MUSIC"
                              : bookshelf
                                ? "YOUR BOOKS"
                                : video
                                  ? "YOUR VIDEOS"
                                  : "YOUR FILES, YOUR SPACE"}
              </p>
              <h1>{title}</h1>
              <p>
                {trash
                  ? "不要になったファイルを確認・復元できます。"
                  : recent
                    ? "最近開いた項目を、現在のアクセス権で確認できます。"
                    : starred
                      ? "自分だけのスターを付けた項目をまとめて確認できます。"
                      : sharing
                        ? "ログイン済みのユーザーとグループに、フォルダーを安全に共有できます。"
                        : shared
                          ? "所有者が許可した現在の操作だけを利用できます。"
                          : gallery
                            ? "アップロードした写真を、サムネイルからすばやく探せます。"
                            : audio
                              ? "プライベートなオーディオを、このスペースから再生できます。"
                              : bookshelf
                                ? "プライベートな EPUB を、安全な章ごとのセッションで読めます。"
                                : video
                                  ? "元の AV1 動画を、対応するブラウザーでそのまま再生できます。"
                                  : "大切なファイルを、いつでも使いやすく。"}
              </p>
            </div>
            {me && personalFiles && (
              <div className="heading-actions">
                <Button
                  disabled={!!recovery}
                  onClick={() =>
                    act({ kind: "share", node: { id: parentId, name: title, kind: "folder" } })
                  }
                >
                  <Share2 size={17} />
                  共有
                </Button>
                <Button disabled={!!recovery} onClick={() => act({ kind: "create" })}>
                  <FolderPlus size={17} />
                  新規フォルダー
                </Button>
                <Button variant="primary" onClick={() => input.current?.click()}>
                  <Upload size={17} />
                  アップロード
                </Button>
              </div>
            )}
          </div>
          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="通知を閉じる"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </Button>
            </div>
          )}
          {recovery && (
            <div className="notice" role="status">
              <span>前回の操作結果が未確認です。同じ操作を確認してから作業を続けてください。</span>
              <Button
                size="small"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  try {
                    await api.mutation(recovery.path, recovery.method, recovery.body, recovery.key);
                    sessionStorage.removeItem(PENDING_KEY);
                    setRecovery(null);
                    refresh();
                  } catch (error) {
                    setNotice(errorMessage(error));
                    if (error instanceof ApiError && error.status < 500) {
                      sessionStorage.removeItem(PENDING_KEY);
                      setRecovery(null);
                    }
                  } finally {
                    setRecovering(false);
                  }
                }}
              >
                結果を確認
              </Button>
            </div>
          )}
          {!me ? (
            <div className="empty-state">
              <Cloud size={40} />
              <h2>{account.isPending ? "スペースを開いています" : "スペースに接続できません"}</h2>
              <p>{account.error ? errorMessage(account.error) : "アカウントを確認しています。"}</p>
              {account.error && (
                <Button
                  onClick={() => {
                    void account.refetch();
                  }}
                >
                  <RefreshCw size={16} />
                  再接続
                </Button>
              )}
            </div>
          ) : sharing ? (
            <InternalShares account={me} />
          ) : shared && sharedMounts.isPending ? (
            <div className="empty-state">
              <LoaderCircle size={28} className="spin" />
              <p>共有フォルダーを確認しています</p>
            </div>
          ) : shared && sharedMounts.error ? (
            <div className="empty-state">
              <FolderOpen size={40} />
              <h2>共有フォルダーを確認できません</h2>
              <p>{errorMessage(sharedMounts.error)}</p>
              <Button onClick={() => void sharedMounts.refetch()}>
                <RefreshCw size={16} />
                再試行
              </Button>
            </div>
          ) : shared && !sharedMount ? (
            <div className="empty-state">
              <FolderOpen size={40} />
              <h2>この共有は利用できません</h2>
              <p>共有の取り消し、期限切れ、またはグループ所属の変更が考えられます。</p>
              <Button asChild>
                <Link to="/shares">内部共有へ戻る</Link>
              </Button>
            </div>
          ) : sharedPathInvalid ? (
            <div className="empty-state">
              <FolderOpen size={40} />
              <h2>共有フォルダーの範囲外です</h2>
              <p>この共有のルートからフォルダーを開き直してください。</p>
              <Button asChild>
                <Link to="/shared/$shareId" params={{ shareId: sharedMount!.shareId }}>
                  共有の先頭へ戻る
                </Link>
              </Button>
            </div>
          ) : gallery ? (
            <PrivateGallery account={me} />
          ) : audio ? (
            <PrivateAudio account={me} />
          ) : bookshelf ? (
            <PrivateBookshelf account={me} />
          ) : video ? (
            <PrivateVideo account={me} />
          ) : (
            <>
              {!trash && statsScope === parentId && (
                <FolderStatsDialog
                  key={`${me.id}:${me.epoch}:${parentId}`}
                  account={me}
                  scopeId={parentId}
                  close={() => setStatsScope(null)}
                />
              )}
              <div className="list-toolbar">
                <div className="list-summary">
                  <strong>{trash ? filteredTrash.length : filtered.length}</strong> 件
                  {!data.error && (data.hasNextPage || truncated) && <span>以上</span>}
                  <span className="toolbar-divider" />
                  {trash
                    ? "削除した項目"
                    : recent
                      ? "最近開いた順"
                      : starred
                        ? "スター付きの項目"
                        : "名前順"}
                </div>
                <div className="toolbar-controls">
                  {!trash && !userState && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="フォルダーの情報"
                      onClick={() => setStatsScope(parentId)}
                    >
                      <Info size={17} />
                    </Button>
                  )}
                  <form
                    className="search-form"
                    role="search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!trash && !userState) {
                        const term = filter.trim();
                        setSearchTerm(term ? { scopeId: parentId, query: term } : null);
                        void query.resetQueries({
                          queryKey: ["search", me.id, me.epoch, parentId, term],
                        });
                      }
                    }}
                  >
                    <label className="list-search">
                      <Search size={16} />
                      <input
                        type="search"
                        aria-label={
                          trash || userState ? "表示中の名前で絞り込む" : "このフォルダー内を検索"
                        }
                        placeholder={
                          trash || userState ? "表示中の名前で絞り込む" : "このフォルダー内を検索"
                        }
                        maxLength={256}
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      />
                    </label>
                    {!trash && !userState && (
                      <Button type="submit" size="small">
                        検索
                      </Button>
                    )}
                  </form>
                  <Button variant="ghost" size="icon" aria-label="一覧を更新" onClick={refresh}>
                    <RefreshCw size={17} className={data.isFetching ? "spin" : ""} />
                  </Button>
                  {!trash && !userState && (
                    <div className="view-switch">
                      <button
                        aria-label="リスト表示"
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <List size={17} />
                      </button>
                      <button
                        aria-label="グリッド表示"
                        aria-pressed={view === "grid"}
                        onClick={() => setView("grid")}
                      >
                        <LayoutGrid size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {searching && (
                <div className="search-summary" role="status">
                  <span>「{searchTerm.query}」の検索結果 · サブフォルダーも含む</span>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setFilter("");
                      setSearchTerm(null);
                    }}
                  >
                    検索を終了
                  </Button>
                </div>
              )}
              {truncated && !data.error && (
                <p className="notice" role="status">
                  検索結果は一部です。検索するフォルダーを絞るか、フォルダー一覧からも確認してください。
                </p>
              )}
              {data.error && (
                <div className="notice" role="alert">
                  {searching && data.error instanceof ApiError && data.error.status === 400
                    ? "検索語を短くして再検索してください。"
                    : searching && data.error instanceof ApiError && data.error.status === 409
                      ? "検索中に項目が更新されました。検索結果を読み直してください。"
                      : errorMessage(data.error)}
                  <Button size="small" onClick={refresh}>
                    一覧を読み直す
                  </Button>
                </div>
              )}
              {data.isPending ? (
                <div className="empty-state">
                  <LoaderCircle size={28} className="spin" />
                  <p>ファイルを読み込んでいます</p>
                </div>
              ) : !data.error && !(trash ? filteredTrash.length : filtered.length) ? (
                <div className="empty-state">
                  <span className="empty-illustration">
                    {trash ? (
                      <Trash2 size={43} strokeWidth={1.3} />
                    ) : starred ? (
                      <Star size={44} strokeWidth={1.3} />
                    ) : recent ? (
                      <Clock3 size={44} strokeWidth={1.3} />
                    ) : (
                      <Folder size={48} strokeWidth={1.3} />
                    )}
                  </span>
                  <h2>
                    {searching || ((trash || userState) && filter)
                      ? "一致する項目がありません"
                      : trash
                        ? "ごみ箱は空です"
                        : recent
                          ? "最近使った項目はありません"
                          : starred
                            ? "スター付きの項目はありません"
                            : shared
                              ? "このフォルダーは空です"
                              : "ファイルを置く場所ができました"}
                  </h2>
                  <p>
                    {searching
                      ? "検索語や検索するフォルダーを変更してください。"
                      : (trash || userState) && filter
                        ? "絞り込み条件を変更するか、次のページを読み込んでください。"
                        : trash
                          ? "ごみ箱に移動した項目は、ここに表示されます。"
                          : recent
                            ? "ファイルやフォルダーを開くと、ここに表示されます。"
                            : starred
                              ? "一覧のスターを選ぶと、ここに表示されます。"
                              : shared
                                ? "現在表示できるファイルやフォルダーはありません。"
                                : "ファイルをドラッグするか、アップロードから追加できます。"}
                  </p>
                  {!trash && !searching && !shared && !userState && (
                    <Button variant="primary" onClick={() => input.current?.click()}>
                      <Upload size={17} />
                      最初のファイルを追加
                    </Button>
                  )}
                </div>
              ) : trash ? (
                <div className="trash-list">
                  {filteredTrash.map((item) => (
                    <article className="trash-row" key={item.opId}>
                      <FileIcon node={{ ...item, mime: null }} />
                      <div>
                        <strong>{item.name}</strong>
                        <p>
                          {time(item.deletedAt)} に削除 · {item.memberCount}項目
                        </p>
                      </div>
                      <Button
                        size="small"
                        disabled={!!recovery}
                        onClick={() => act({ kind: "restore", item })}
                      >
                        復元
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${item.name}を完全に削除`}
                        disabled={!!recovery}
                        onClick={() => act({ kind: "purge", item })}
                      >
                        <Trash2 size={17} />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : (
                <FileList
                  rows={filtered}
                  view={view}
                  act={act}
                  open={openNode}
                  readOnly={shared}
                  currentUserId={me.id}
                  toggleStar={toggleStar}
                  starPending={starPending}
                />
              )}
              <div className="list-footer">
                <span>
                  {recent
                    ? "現在もアクセスできる項目だけを最近開いた順に表示します"
                    : starred
                      ? "スターは自分のアカウントだけに保存されます"
                      : searching
                        ? "検索結果は名前順に表示されます"
                        : filter && trash
                          ? "読み込み済みの項目を絞り込んでいます"
                          : "ファイルは名前順に表示されます"}
                </span>
                {data.hasNextPage && !data.error && (
                  <Button
                    disabled={data.isFetchingNextPage}
                    onClick={() => {
                      void data.fetchNextPage();
                    }}
                  >
                    さらに読み込む
                    <ArrowRight size={15} />
                  </Button>
                )}
              </div>
            </>
          )}
          <input
            ref={input}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </main>
      </div>
      <UploadPanel />
      {action?.kind === "overwrite" && me && (
        <OverwriteDialog
          key={JSON.stringify(action)}
          node={action.node}
          account={me}
          parentId={action.node.parentId ?? parentId}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "share" && me && (
        <ShareDialog
          key={JSON.stringify(action)}
          node={action.node}
          account={me}
          onClose={() => setAction(null)}
        />
      )}
      {action && action.kind !== "overwrite" && action.kind !== "share" && me && (
        <OperationDialog
          key={JSON.stringify(action)}
          action={action}
          account={me}
          parentId={parentId}
          onClose={() => {
            setAction(null);
            try {
              const saved = sessionStorage.getItem(PENDING_KEY);
              if (saved) setRecovery(JSON.parse(saved) as Pending);
            } catch {}
          }}
          refresh={refresh}
        />
      )}
    </div>
  );
}
