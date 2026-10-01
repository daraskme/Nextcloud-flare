import { useQuery } from "@tanstack/react-query";
import { Download, Film, LoaderCircle, RefreshCw, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type Account,
  ApiError,
  api,
  errorMessage,
  type FileNode,
  formatBytes,
  type PlaybackState,
  type PreparedContentSession,
} from "../../lib/api";
import { type DebouncedWriter, debouncedWriter } from "../../lib/mediaResume";

const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv", "avi"] as const;

function extension(name: string) {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}

export function PrivateVideo({ account }: { account: Account }) {
  const query = useQuery({
    queryKey: ["video", account.id, account.epoch, account.rootNodeId],
    queryFn: ({ signal }) => api.filesByExtensions(account.rootNodeId, VIDEO_EXTENSIONS, signal),
  });
  const video = useRef<HTMLVideoElement>(null);
  const request = useRef<AbortController | null>(null);
  const content = useRef<PreparedContentSession | null>(null);
  const selection = useRef(0);
  const activeRef = useRef<FileNode | null>(null);
  const terminal = useRef(false);
  const resume = useRef<PlaybackState | null>(null);
  const writer = useRef<DebouncedWriter<number> | null>(null);
  const [active, setActive] = useState<FileNode | null>(null);
  const [source, setSource] = useState("");
  const [contentType, setContentType] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [playerError, setPlayerError] = useState("");

  const currentPositionMs = () => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return null;
    return Math.min(Math.round(element.currentTime * 1_000), Math.round(element.duration * 1_000));
  };

  const flush = async (positionMs?: number) => {
    const selected = positionMs ?? currentPositionMs();
    if (selected !== null) await writer.current?.flush(selected);
  };

  const release = () => {
    request.current?.abort();
    request.current = null;
    if (content.current) void content.current.cancel().catch(() => undefined);
    content.current = null;
    resume.current = null;
    writer.current?.clear();
    writer.current = null;
  };

  useEffect(
    () => () => {
      void flush().catch(() => undefined);
      release();
    },
    [],
  );

  const select = async (item: FileNode) => {
    if (!terminal.current) await flush().catch(() => undefined);
    release();
    terminal.current = false;
    const selected = ++selection.current;
    activeRef.current = item;
    setActive(item);
    setSource("");
    setContentType("");
    setPlayerError("");
    setPreparing(false);
    const element = video.current;
    if (element) {
      element.removeAttribute("src");
      element.load();
    }
    const blobId = item.currentBlobId;
    if (!["mp4", "webm"].includes(extension(item.name)) || !blobId) {
      setPlayerError(
        "この動画形式はブラウザー再生に対応していません。原本を保存して確認できます。",
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPreparing(true);
    try {
      const stateFlight = api.playbackState(item.id, controller.signal).catch(() => undefined);
      const session = await api.prepareContentSession(
        account,
        [{ id: item.id, currentBlobId: blobId }],
        "track",
        controller.signal,
      );
      content.current = session;
      const url = session.url({ id: item.id, currentBlobId: blobId });
      const response = await fetch(url, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new ApiError(response.status, "video_metadata_failed");
      const type = response.headers.get("Content-Type") ?? "";
      if (!type.startsWith("video/")) throw new Error("invalid_video_content_type");
      if (document.createElement("video").canPlayType(type) === "") {
        await session.cancel();
        if (content.current === session) content.current = null;
        setPlayerError(
          "この端末は動画の codec を再生できません。原本を保存するか、対応ブラウザーで確認してください。",
        );
        return;
      }
      controller.signal.throwIfAborted();
      if (selected !== selection.current) {
        await session.cancel().catch(() => undefined);
        return;
      }
      const state = await stateFlight;
      controller.signal.throwIfAborted();
      if (selected !== selection.current) {
        await session.cancel().catch(() => undefined);
        return;
      }
      writer.current = debouncedWriter((positionMs) =>
        api.writePlaybackState(item.id, blobId, positionMs),
      );
      resume.current = state?.nodeId === item.id && state.blobId === blobId ? state : null;
      setContentType(type);
      setSource(url);
    } catch (error) {
      if (!controller.signal.aborted && selected === selection.current) {
        const stale = content.current;
        if (stale) {
          void stale.cancel().catch(() => undefined);
          content.current = null;
        }
        setPlayerError(
          error instanceof ApiError && [401, 403, 404].includes(error.status)
            ? "動画セッションが失効したか、動画が更新されました。再読み込みしてください。"
            : errorMessage(error),
        );
      }
    } finally {
      if (!controller.signal.aborted && selected === selection.current) setPreparing(false);
    }
  };

  const download = (item: FileNode) => {
    if (!item.currentBlobId) return;
    const target = window.open("", "_blank");
    if (!target) {
      setPlayerError("新しいタブを開けませんでした。ブラウザーの設定を確認してください。");
      return;
    }
    void api.openFile(account, item, target).catch((error) => setPlayerError(errorMessage(error)));
  };

  const items = query.data?.items ?? [];

  if (query.isPending)
    return (
      <div className="empty-state">
        <LoaderCircle size={30} className="spin" />
        <p>動画を読み込んでいます</p>
      </div>
    );
  if (query.error)
    return (
      <div className="empty-state">
        <Video size={44} strokeWidth={1.3} />
        <h2>動画を開けません</h2>
        <p>{errorMessage(query.error)}</p>
        <Button onClick={() => void query.refetch()}>
          <RefreshCw size={16} />
          読み直す
        </Button>
      </div>
    );
  if (!items.length)
    return (
      <div className="empty-state">
        <Video size={48} strokeWidth={1.3} />
        <h2>動画がありません</h2>
        <p>AV1 の MP4 または WebM をアップロードすると、ここから再生できます。</p>
      </div>
    );

  return (
    <>
      <div className="media-toolbar">
        <span>
          <strong>{items.length}</strong> 本{query.data?.truncated && "以上"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="動画を更新"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
        </Button>
      </div>
      {playerError && (
        <div className="notice" role="alert">
          <span>{playerError}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="通知を閉じる"
            onClick={() => setPlayerError("")}
          >
            <X size={16} />
          </Button>
        </div>
      )}
      <div className="video-layout">
        <div className="video-stage">
          {preparing ? (
            <div className="video-placeholder">
              <LoaderCircle size={32} className="spin" />
              <p>再生セッションを準備しています</p>
            </div>
          ) : source ? (
            <>
              <video
                ref={video}
                src={source}
                controls
                preload="none"
                playsInline
                aria-label={active?.name}
                onLoadedMetadata={(event) => {
                  const state = resume.current;
                  const item = activeRef.current;
                  const element = event.currentTarget;
                  if (
                    !state ||
                    !item ||
                    state.nodeId !== item.id ||
                    state.blobId !== item.currentBlobId ||
                    state.positionMs === null ||
                    state.durationMs <= 0 ||
                    !Number.isFinite(element.duration) ||
                    element.duration <= 0
                  )
                    return;
                  const seconds = Math.min(
                    state.positionMs / 1_000,
                    state.durationMs / 1_000,
                    element.duration,
                  );
                  if (seconds > 0 && seconds < element.duration) element.currentTime = seconds;
                  resume.current = null;
                }}
                onTimeUpdate={() => {
                  const positionMs = currentPositionMs();
                  if (positionMs !== null) writer.current?.schedule(positionMs);
                }}
                onPause={() => void flush().catch(() => undefined)}
                onPlay={() => {
                  terminal.current = false;
                }}
                onEnded={() => {
                  terminal.current = true;
                  void flush(0).catch(() => undefined);
                }}
                onError={() => {
                  setPlayerError(
                    "動画を再生できませんでした。セッションの失効または端末の codec 対応を確認してください。",
                  );
                  setSource("");
                  setContentType("");
                  release();
                }}
              >
                <track kind="captions" />
              </video>
              <div className="video-meta">
                <strong>{active?.name}</strong>
                <span>{contentType}</span>
              </div>
            </>
          ) : (
            <div className="video-placeholder">
              <Film size={50} strokeWidth={1.2} />
              <h2>{active ? active.name : "動画を選択"}</h2>
              <p>一覧から動画を選ぶと、安全な原本配信セッションを準備します。</p>
              {active && (
                <Button onClick={() => download(active)}>
                  <Download size={16} />
                  原本を保存
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="video-list" aria-label="動画一覧">
          {items.map((item) => {
            const supportedContainer = ["mp4", "webm"].includes(extension(item.name));
            return (
              <button
                className={`video-row ${active?.id === item.id ? "video-row-active" : ""}`}
                key={item.id}
                onClick={() => void select(item)}
              >
                <span className="video-row-icon">
                  <Video size={19} />
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {supportedContainer ? "AV1 メタデータを確認して再生" : "ブラウザー再生非対応"} ·{" "}
                    {formatBytes(item.size)}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
