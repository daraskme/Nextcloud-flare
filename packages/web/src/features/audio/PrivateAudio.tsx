import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  LoaderCircle,
  Music,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type Account,
  type AudioTrack,
  api,
  errorMessage,
  type PreparedContentSession,
} from "../../lib/api";
import { type DebouncedWriter, debouncedWriter } from "../../lib/mediaResume";

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

export function PrivateAudio({ account }: { account: Account }) {
  const query = useInfiniteQuery({
    queryKey: ["audio", account.id, account.epoch, account.rootNodeId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.tracks(account.rootNodeId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
  });
  const tracks = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef<AbortController | null>(null);
  const content = useRef<PreparedContentSession | null>(null);
  const selection = useRef(0);
  const activeRef = useRef<AudioTrack | null>(null);
  const resume = useRef<{ blobId: string; positionMs: number; durationMs: number } | null>(null);
  const writer = useRef<DebouncedWriter<number> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [playerError, setPlayerError] = useState("");
  const activeIndex = tracks.findIndex((track) => track.id === activeId);
  const active = activeIndex >= 0 ? tracks[activeIndex] : undefined;

  const currentPositionMs = () => {
    const element = audio.current;
    const track = activeRef.current;
    if (
      !element ||
      !track ||
      track.durationMs === null ||
      !Number.isFinite(element.duration) ||
      element.duration <= 0
    )
      return null;
    return Math.min(Math.round(element.currentTime * 1_000), Math.round(element.duration * 1_000));
  };

  const flush = (positionMs?: number) => {
    const selected = positionMs ?? currentPositionMs();
    if (selected !== null) void writer.current?.flush(selected).catch(() => undefined);
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

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const update = () => {
      setPosition(element.currentTime);
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      const selected = currentPositionMs();
      if (selected !== null) writer.current?.schedule(selected);
    };
    const paused = () => {
      setPlaying(false);
      flush();
    };
    const started = () => setPlaying(true);
    const loaded = () => {
      const state = resume.current;
      const track = activeRef.current;
      if (
        !state ||
        !track ||
        state.blobId !== track.currentBlobId ||
        !Number.isFinite(element.duration) ||
        element.duration <= 0
      )
        return;
      const seconds = Math.min(state.positionMs / 1_000, element.duration);
      if (seconds > 0 && seconds < element.duration) element.currentTime = seconds;
      resume.current = null;
    };
    const ended = () => {
      setPlaying(false);
      flush(0);
    };
    const failed = () => {
      setPlaying(false);
      setPlayerError("このトラックを再生できませんでした。");
    };
    element.addEventListener("timeupdate", update);
    element.addEventListener("durationchange", update);
    element.addEventListener("loadedmetadata", loaded);
    element.addEventListener("pause", paused);
    element.addEventListener("play", started);
    element.addEventListener("ended", ended);
    element.addEventListener("error", failed);
    return () => {
      flush();
      release();
      element.removeEventListener("timeupdate", update);
      element.removeEventListener("durationchange", update);
      element.removeEventListener("loadedmetadata", loaded);
      element.removeEventListener("pause", paused);
      element.removeEventListener("play", started);
      element.removeEventListener("ended", ended);
      element.removeEventListener("error", failed);
    };
  }, []);

  const select = async (track: AudioTrack) => {
    const element = audio.current;
    if (!element) return;
    if (activeId === track.id && element.src) {
      if (element.paused) await element.play();
      else element.pause();
      return;
    }
    flush();
    release();
    const selected = ++selection.current;
    activeRef.current = track;
    setActiveId(track.id);
    setPreparing(true);
    setPlayerError("");
    setPosition(0);
    setDuration(0);
    const controller = new AbortController();
    request.current = controller;
    try {
      const [session, state] = await Promise.all([
        api.prepareContentSession(account, [track], "track", controller.signal),
        track.durationMs === null
          ? undefined
          : api.playbackState(track.id, controller.signal).catch(() => undefined),
      ]);
      if (controller.signal.aborted || selected !== selection.current) {
        await session.cancel().catch(() => undefined);
        return;
      }
      content.current = session;
      writer.current =
        track.durationMs === null
          ? null
          : debouncedWriter((positionMs) =>
              api.writePlaybackState(track.id, track.currentBlobId, positionMs),
            );
      resume.current =
        state?.nodeId === track.id &&
        state.blobId === track.currentBlobId &&
        state.positionMs !== null &&
        state.durationMs > 0
          ? {
              blobId: state.blobId,
              positionMs: Math.min(state.positionMs, state.durationMs),
              durationMs: state.durationMs,
            }
          : null;
      element.src = session.url(track);
      element.volume = volume;
      await element.play();
    } catch (error) {
      if (!controller.signal.aborted && selected === selection.current) {
        setPlayerError(errorMessage(error));
        setPlaying(false);
      }
    } finally {
      if (!controller.signal.aborted && selected === selection.current) setPreparing(false);
    }
  };
  const move = (offset: number) => {
    const next = tracks[activeIndex + offset];
    if (next) void select(next);
  };

  if (query.isPending)
    return (
      <div className="empty-state">
        <LoaderCircle size={30} className="spin" />
        <p>オーディオを読み込んでいます</p>
      </div>
    );
  if (query.error)
    return (
      <div className="empty-state">
        <Music size={44} strokeWidth={1.3} />
        <h2>オーディオを開けません</h2>
        <p>{errorMessage(query.error)}</p>
        <Button onClick={() => void query.refetch()}>
          <RefreshCw size={16} />
          読み直す
        </Button>
      </div>
    );
  if (!tracks.length)
    return (
      <div className="empty-state">
        <Music size={48} strokeWidth={1.3} />
        <h2>再生できるトラックがありません</h2>
        <p>対応するオーディオをアップロードすると、ここから再生できます。</p>
      </div>
    );

  return (
    <>
      <audio ref={audio} preload="metadata" onEnded={() => move(1)}>
        <track kind="captions" />
      </audio>
      <div className="media-toolbar">
        <span>
          <strong>{tracks.length}</strong> 曲{query.hasNextPage && "以上"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="オーディオを更新"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
        </Button>
      </div>
      {playerError && (
        <div className="notice" role="alert">
          {playerError}
        </div>
      )}
      <div className="audio-list">
        {tracks.map((track, index) => (
          <button
            className={`audio-row ${track.id === activeId ? "audio-row-active" : ""}`}
            key={track.id}
            onClick={() => void select(track)}
          >
            <span className="audio-play">
              {preparing && track.id === activeId ? (
                <LoaderCircle size={18} className="spin" />
              ) : playing && track.id === activeId ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </span>
            <span className="audio-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="audio-title">
              <strong>{track.title}</strong>
              <small>{track.artist ?? track.name}</small>
            </span>
            <span className="audio-album">{track.album ?? "—"}</span>
            <span className="audio-duration">
              {track.durationMs === null ? "—" : clock(track.durationMs / 1000)}
            </span>
          </button>
        ))}
      </div>
      {query.hasNextPage && (
        <div className="list-footer">
          <span>ファイル名順に表示しています</span>
          <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            さらに読み込む
            <ArrowRight size={15} />
          </Button>
        </div>
      )}
      <div className="audio-player">
        <div className="audio-now">
          <span className="audio-cover">
            <Music size={22} />
          </span>
          <span>
            <strong>{active?.title ?? "トラックを選択"}</strong>
            <small>{active?.artist ?? "オーディオライブラリー"}</small>
          </span>
        </div>
        <div className="audio-controls">
          <div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="前のトラック"
              disabled={activeIndex <= 0}
              onClick={() => move(-1)}
            >
              <SkipBack size={18} fill="currentColor" />
            </Button>
            <Button
              className="audio-primary"
              size="icon"
              aria-label={playing ? "一時停止" : "再生"}
              disabled={!active || preparing}
              onClick={() => active && void select(active)}
            >
              {playing ? (
                <Pause size={19} fill="currentColor" />
              ) : (
                <Play size={19} fill="currentColor" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="次のトラック"
              disabled={activeIndex < 0 || activeIndex >= tracks.length - 1}
              onClick={() => move(1)}
            >
              <SkipForward size={18} fill="currentColor" />
            </Button>
          </div>
          <label className="audio-progress">
            <span>{clock(position)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={1}
              value={Math.min(position, Math.max(duration, 1))}
              aria-label="再生位置"
              disabled={!active || !duration}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (audio.current) audio.current.currentTime = value;
                setPosition(value);
              }}
            />
            <span>{clock(duration)}</span>
          </label>
        </div>
        <label className="audio-volume">
          <Volume2 size={17} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label="音量"
            onChange={(event) => {
              const value = Number(event.target.value);
              setVolume(value);
              if (audio.current) audio.current.volume = value;
            }}
          />
        </label>
      </div>
    </>
  );
}
