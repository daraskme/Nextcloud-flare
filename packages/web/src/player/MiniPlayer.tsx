import type { AudioTrackSummary } from "@ncf/shared";
import { ListMusic, Pause, Play, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PlayQueueDetail } from "../features/audio/AudioView";
import { t } from "../i18n";
import { api } from "../lib/api";

export function MiniPlayer(): React.JSX.Element | null {
  const audio = useRef<HTMLAudioElement>(null);
  const lastSaved = useRef(0);
  const [tracks, setTracks] = useState<AudioTrackSummary[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [queueOpen, setQueueOpen] = useState(false);
  const current = tracks[index];

  const savePosition = () => {
    const player = audio.current;
    if (player === null || current === undefined || !Number.isFinite(player.currentTime)) return;
    void api.savePlaybackState(current.nodeId, Math.max(0, Math.round(player.currentTime * 1000)));
    lastSaved.current = Date.now();
  };

  const select = (next: number) => {
    savePosition();
    setIndex(Math.max(0, Math.min(tracks.length - 1, next)));
  };

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<PlayQueueDetail>).detail;
      if (!Array.isArray(detail.tracks) || detail.tracks.length === 0) return;
      setTracks(detail.tracks);
      setIndex(Math.max(0, Math.min(detail.tracks.length - 1, detail.index)));
      setPlaying(true);
    };
    window.addEventListener("ncf-play-queue", listener);
    return () => window.removeEventListener("ncf-play-queue", listener);
  }, []);

  useEffect(() => {
    const player = audio.current;
    if (player === null || current === undefined) return;
    player.src = current.contentUrl;
    player.load();
    const loaded = () => {
      if (current.positionMs > 0 && current.positionMs < player.duration * 1000) {
        player.currentTime = current.positionMs / 1000;
      }
      if (playing) void player.play().catch(() => setPlaying(false));
    };
    player.addEventListener("loadedmetadata", loaded, { once: true });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist ?? "",
        album: current.album ?? "",
        artwork:
          current.coverUrl === null
            ? []
            : [{ src: current.coverUrl, sizes: "512x512", type: "image/webp" }],
      });
    }
    return () => player.removeEventListener("loadedmetadata", loaded);
  }, [current?.nodeId]);

  useEffect(() => {
    const player = audio.current;
    if (player === null) return;
    player.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => {
      setPlaying(true);
      void audio.current?.play();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      setPlaying(false);
      audio.current?.pause();
      savePosition();
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => select(index - 1));
    navigator.mediaSession.setActionHandler("nexttrack", () => select(index + 1));
    return () => {
      for (const action of ["play", "pause", "previoustrack", "nexttrack"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [index, tracks]);

  if (current === undefined) return null;
  return (
    <aside className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-4xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl">
      <audio
        ref={audio}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          savePosition();
        }}
        onEnded={() => {
          savePosition();
          if (index + 1 < tracks.length) select(index + 1);
          else setPlaying(false);
        }}
        onTimeUpdate={() => {
          if (Date.now() - lastSaved.current > 10_000) savePosition();
        }}
      />
      {queueOpen && (
        <div className="absolute bottom-[calc(100%+.5rem)] right-0 max-h-72 w-[min(28rem,calc(100vw-1.5rem))] overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-2xl">
          {tracks.map((track, trackIndex) => (
            <button
              key={`${track.nodeId}-${trackIndex}`}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ${trackIndex === index ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-muted)]"}`}
              onClick={() => select(trackIndex)}
            >
              <span className="w-6 text-right text-xs text-[var(--fg-muted)]">
                {track.trackNo ?? trackIndex + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{track.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        {current.coverUrl === null ? (
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--surface-muted)]">
            <ListMusic className="h-5 w-5 text-[var(--accent)]" />
          </div>
        ) : (
          <img
            className="h-11 w-11 shrink-0 rounded-xl object-cover"
            src={current.coverUrl}
            alt=""
          />
        )}
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{current.title}</strong>
          <span className="block truncate text-xs text-[var(--fg-muted)]">
            {current.artist ?? current.name}
          </span>
        </div>
        <button
          className="icon-button hidden sm:grid"
          disabled={index === 0}
          onClick={() => select(index - 1)}
          aria-label={t("audio.previous")}
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          className="grid h-10 w-10 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)]"
          onClick={() => {
            const player = audio.current;
            if (player === null) return;
            if (playing) player.pause();
            else void player.play();
          }}
          aria-label={playing ? t("audio.pause") : t("audio.play")}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button
          className="icon-button hidden sm:grid"
          disabled={index + 1 >= tracks.length}
          onClick={() => select(index + 1)}
          aria-label={t("audio.next")}
        >
          <SkipForward className="h-4 w-4" />
        </button>
        <label className="hidden items-center gap-2 md:flex" aria-label={t("audio.volume")}>
          <Volume2 className="h-4 w-4 text-[var(--fg-muted)]" />
          <input
            className="w-20 accent-[var(--accent)]"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </label>
        <button
          className="icon-button"
          onClick={() => setQueueOpen((value) => !value)}
          aria-label={t("audio.queue")}
        >
          <ListMusic className="h-4 w-4" />
        </button>
        <button
          className="icon-button"
          onClick={() => {
            savePosition();
            audio.current?.pause();
            setTracks([]);
          }}
          aria-label={t("audio.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
