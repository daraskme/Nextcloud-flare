import * as Menu from "@radix-ui/react-dropdown-menu";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Cloud,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  LoaderCircle,
  LogOut,
  Menu as MenuIcon,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { type UploadTask, uploads } from "./features/uploads/manager";
import { OverwriteDialog } from "./features/uploads/OverwriteDialog";
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
  action: Exclude<Action, { kind: "overwrite" }>;
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
          {node.kind === "file" && (
            <Menu.Item onSelect={() => act({ kind: "overwrite", node })}>
              ファイルを上書き
            </Menu.Item>
          )}
          <Menu.Item onSelect={() => act({ kind: "rename", node })}>名前を変更</Menu.Item>
          <Menu.Item onSelect={() => act({ kind: "move", node })}>移動</Menu.Item>
          <Menu.Item onSelect={() => act({ kind: "copy", node })}>コピー</Menu.Item>
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
}: {
  rows: FileNode[];
  view: "list" | "grid";
  act: (action: Action) => void;
  open: (node: FileNode) => void;
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
              <NodeMenu node={node} act={act} open={() => open(node)} />
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
                  <NodeMenu node={node} act={act} open={() => open(node)} />
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
  const parentId = /^\/files\/([^/]+)$/.exec(pathname)?.[1] ?? me?.rootNodeId ?? "";
  const [view, setView] = useState<"list" | "grid">("list");
  const [filter, setFilter] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [recovery, setRecovery] = useState<Pending | null>(null);
  const [recovering, setRecovering] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const listing = useInfiniteQuery({
    queryKey: ["children", me?.id, me?.epoch, parentId],
    queryFn: ({ pageParam, signal }) => api.children(parentId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!me && !trash,
    retry: false,
  });
  const path = useQuery({
    queryKey: ["path", me?.id, me?.epoch, parentId],
    queryFn: ({ signal }) => api.path(parentId, signal),
    enabled: !!me && !trash,
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
  const refresh = () => {
    for (const key of ["children", "trash", "path", "picker"])
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
  const addFiles = async (files: FileList | null) => {
    if (!files || !me || trash) return;
    for (const file of Array.from(files)) {
      try {
        await uploads.enqueue(file, me, parentId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "アップロードを開始できません。");
        break;
      }
    }
  };
  const openNode = (node: FileNode) => {
    if (node.kind === "folder") {
      void navigate({ to: "/files/$folderId", params: { folderId: node.id } });
      return;
    }
    const target = window.open("about:blank", "_blank");
    if (!target || !me) {
      setNotice("ファイルを開くには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    void api.openFile(me, node, target).catch((error) => setNotice(errorMessage(error)));
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
  const filtered = rows.filter((node) =>
    node.name.toLocaleLowerCase("ja-JP").includes(filter.toLocaleLowerCase("ja-JP")),
  );
  const filteredTrash = items.filter((item) =>
    item.name.toLocaleLowerCase("ja-JP").includes(filter.toLocaleLowerCase("ja-JP")),
  );
  const data = trash ? trashed : listing;
  const title = trash ? "ごみ箱" : path.data?.path.at(-1)?.name || "マイドライブ";
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
          <Link to="/files" className={!trash ? "nav-link active" : "nav-link"}>
            <HardDrive size={19} />
            マイドライブ
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
            <span>パーソナルスペース</span>
            <ChevronRight size={14} />
            <span className="muted">ファイル</span>
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
            if (!trash && event.dataTransfer.types.includes("Files")) {
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
            <Link to="/files">マイドライブ</Link>
            {!trash &&
              path.data?.path.slice(1).map((crumb) => (
                <span key={crumb.id}>
                  <ChevronRight size={13} />
                  <Link to="/files/$folderId" params={{ folderId: crumb.id }}>
                    {crumb.name}
                  </Link>
                </span>
              ))}
            {trash && (
              <span>
                <ChevronRight size={13} />
                ごみ箱
              </span>
            )}
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">{trash ? "TRASH" : "YOUR FILES, YOUR SPACE"}</p>
              <h1>{title}</h1>
              <p>
                {trash
                  ? "不要になったファイルを確認・復元できます。"
                  : "大切なファイルを、いつでも使いやすく。"}
              </p>
            </div>
            {me && !trash && (
              <div className="heading-actions">
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
          ) : (
            <>
              <div className="list-toolbar">
                <div className="list-summary">
                  <strong>{trash ? filteredTrash.length : filtered.length}</strong> 件
                  {data.hasNextPage && <span>以上</span>}
                  <span className="toolbar-divider" />
                  {trash ? "削除した項目" : "名前順"}
                </div>
                <div className="toolbar-controls">
                  <label className="list-search">
                    <Search size={16} />
                    <input
                      aria-label="表示中の名前で絞り込む"
                      placeholder="表示中の名前で絞り込む"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </label>
                  <Button variant="ghost" size="icon" aria-label="一覧を更新" onClick={refresh}>
                    <RefreshCw size={17} className={data.isFetching ? "spin" : ""} />
                  </Button>
                  {!trash && (
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
              {data.error && (
                <div className="notice" role="alert">
                  {errorMessage(data.error)}
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
                    ) : (
                      <Folder size={48} strokeWidth={1.3} />
                    )}
                  </span>
                  <h2>
                    {filter
                      ? "一致する項目がありません"
                      : trash
                        ? "ごみ箱は空です"
                        : "ファイルを置く場所ができました"}
                  </h2>
                  <p>
                    {filter
                      ? "絞り込み条件を変更するか、次のページを読み込んでください。"
                      : trash
                        ? "ごみ箱に移動した項目は、ここに表示されます。"
                        : "ファイルをドラッグするか、アップロードから追加できます。"}
                  </p>
                  {!filter && !trash && (
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
                <FileList rows={filtered} view={view} act={act} open={openNode} />
              )}
              <div className="list-footer">
                <span>
                  {filter
                    ? "読み込み済みの項目を絞り込んでいます"
                    : "ファイルは名前順に表示されます"}
                </span>
                {data.hasNextPage && (
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
          parentId={parentId}
          onClose={() => setAction(null)}
        />
      )}
      {action && action.kind !== "overwrite" && me && (
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
