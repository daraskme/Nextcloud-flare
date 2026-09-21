import type { AudioTrackSummary, NodeSummary } from "@ncf/shared";
import { Disc3, Folder, Music, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../../i18n";
import { api } from "../../lib/api";

export interface PlayQueueDetail {
  tracks: AudioTrackSummary[];
  index: number;
}

function duration(value: number | null): string {
  if (value === null) return "--:--";
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AudioView({ rootId }: { rootId: string }): React.JSX.Element {
  const [folderId, setFolderId] = useState(rootId);
  const [folders, setFolders] = useState<NodeSummary[]>([]);
  const [tracks, setTracks] = useState<AudioTrackSummary[]>([]);
  const [albumName, setAlbumName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [album, children] = await Promise.all([
        api.tracks(folderId),
        folderId === rootId ? api.children(rootId) : Promise.resolve({ items: [] }),
      ]);
      setTracks(album.tracks);
      setAlbumName(album.name || t("app.myDrive"));
      setFolders(children.items.filter((item) => item.kind === "folder"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("audio.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [folderId]);

  const play = (index: number) => {
    window.dispatchEvent(
      new CustomEvent<PlayQueueDetail>("ncf-play-queue", { detail: { tracks, index } }),
    );
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4 sm:px-8">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-500/15 text-[var(--success)]">
          <Music className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[.18em] text-[var(--accent)]">
            {t("audio.eyebrow")}
          </p>
          <h2 className="truncate text-xl font-semibold">{t("audio.title")}</h2>
        </div>
        <button className="icon-button" onClick={() => void load()} aria-label={t("files.refresh")}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error !== null && (
        <p className="mx-5 mt-4 rounded-xl bg-rose-500/10 p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5 pb-28 sm:p-8 sm:pb-28">
        {folderId === rootId && folders.length > 0 && (
          <div className="mb-8">
            <h3 className="mb-3 text-sm font-semibold">{t("audio.albums")}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
                  onClick={() => setFolderId(folder.id)}
                >
                  <Folder className="h-8 w-8 text-[var(--accent)]" />
                  <span className="min-w-0 truncate text-sm font-medium">{folder.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mb-4 flex items-center gap-3">
          <Disc3 className="h-5 w-5 text-[var(--accent)]" />
          <h3 className="min-w-0 flex-1 truncate text-lg font-semibold">{albumName}</h3>
          {folderId !== rootId && (
            <button
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
              onClick={() => setFolderId(rootId)}
            >
              {t("audio.allAlbums")}
            </button>
          )}
        </div>
        {!loading && tracks.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed border-[var(--border)] text-sm text-[var(--fg-muted)]">
            {t("audio.empty")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {tracks.map((track, index) => (
              <button
                key={track.nodeId}
                className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-left transition last:border-0 hover:bg-[var(--surface-hover)]"
                onClick={() => play(index)}
              >
                <span className="grid h-8 w-8 place-items-center rounded-lg text-xs text-[var(--fg-muted)]">
                  {track.trackNo ?? <Play className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm">{track.title}</strong>
                  <span className="mt-0.5 block truncate text-xs text-[var(--fg-muted)]">
                    {[track.artist, track.album].filter(Boolean).join(" · ") || track.name}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-[var(--fg-muted)]">
                  {duration(track.durationMs)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
