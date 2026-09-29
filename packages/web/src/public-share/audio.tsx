import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AudioPage } from "../../../shared/src/audio";
import { type AudioClient, readAudioPage } from "./audioClient";
import { AudioPlayer, audioDenied } from "./audioPlayer";
import "./audio.css";

const Context = createContext<AudioPlayer | null>(null);
export function useAudioPlayer() {
  const value = useContext(Context);
  if (!value) throw new Error("audio_provider_missing");
  return value;
}
export function audioTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
export function AudioProvider({ children }: { children: ReactNode }) {
  const [player] = useState(() => new AudioPlayer(document.createElement("audio")));
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.append(player.media);
    const flush = () => {
      void player.flush();
    };
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      player.dispose();
      player.media.remove();
    };
  }, [player]);
  return (
    <Context.Provider value={player}>
      {children}
      <div ref={host} hidden />
      {(state.track || state.message) && <div className="audio-spacer" />}
      {(state.track || state.message) && (
        <section className="audio-player" aria-label="オーディオプレーヤー">
          {state.track && (
            <>
              <div className="audio-now">
                <strong title={state.track.title}>{state.track.title}</strong>
                <small title={state.track.artist || state.track.name}>
                  {state.track.artist || state.track.name}
                </small>
              </div>
              <div className="audio-controls">
                <button
                  type="button"
                  disabled={!state.previous}
                  onClick={() => void player.skip(-1)}
                  aria-label="前の曲"
                >
                  ⏮
                </button>
                <button
                  type="button"
                  disabled={state.loading}
                  onClick={() => void player.toggle()}
                  aria-label={state.playing ? "一時停止" : "再生"}
                >
                  {state.loading ? "読込中…" : state.playing ? "一時停止" : "再生"}
                </button>
                <button
                  type="button"
                  disabled={!state.next}
                  onClick={() => void player.skip(1)}
                  aria-label="次の曲"
                >
                  ⏭
                </button>
                <span className="audio-time" aria-label="再生時間">
                  {audioTime(state.position)} / {audioTime(state.duration)}
                </span>
              </div>
              <label className="audio-volume">
                音量
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={state.volume}
                  onChange={(e) => player.volume(Number(e.target.value))}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const target = window.open("about:blank", "_blank");
                  if (target) {
                    target.opener = null;
                    void player.download(target);
                  }
                }}
              >
                原本をダウンロード
              </button>
            </>
          )}
          <button type="button" onClick={() => void player.close()} aria-label="プレーヤーを閉じる">
            閉じる
          </button>
          {state.message && (
            <p role="status" className="audio-message">
              {state.message}
            </p>
          )}
          {state.reload && (
            <button type="button" onClick={() => void player.reload()}>
              保存済みの位置から再開
            </button>
          )}
        </section>
      )}
    </Context.Provider>
  );
}

export function AudioLibrary({ client }: { client: AudioClient }) {
  const player = useAudioPlayer();
  const playing = useSyncExternalStore(player.subscribe, player.getSelectionSnapshot);
  const [page, setPage] = useState<AudioPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const load = async (previous: AudioPage | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const signal = AbortSignal.any([controller.signal, client.signal]);
    setBusy(true);
    setError("");
    try {
      const result = await readAudioPage(client, previous, signal);
      setPage(result);
      player.updateQueue(client, result);
    } catch (failure) {
      if (signal.aborted) return;
      setPage(null);
      setError("曲一覧を読み込めませんでした。共有設定や接続を確認して、一覧を更新してください。");
      if (audioDenied(failure) && player.getSnapshot().scope === client.scope)
        void player.close(false);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    void load(null);
    return () => request.current?.abort();
  }, [client]);
  return (
    <section className="audio-library" aria-label="オーディオ">
      <header>
        <div>
          <h2>曲一覧</h2>
          <p>このフォルダーの音声を再生します。対応形式：Opus（Ogg・WebM・MP4）</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load(null)}>
          曲一覧を更新
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">曲を読み込んでいます…</p>}
      {page?.items.length === 0 && !page.nextCursor && (
        <p>再生できる曲がありません。ファイル一覧から音声のあるフォルダーを開いてください。</p>
      )}
      {page?.items.length === 0 && page.nextCursor && (
        <p role="status">まだ曲が見つかっていません。続けて読み込むと、次の項目を確認します。</p>
      )}
      <ol className="audio-tracks">
        {page?.items.map((item) => (
          <li
            key={item.id}
            className={
              playing.scope === client.scope && playing.trackId === item.id ? "audio-selected" : ""
            }
          >
            <button
              type="button"
              aria-label={`${item.name}を再生`}
              onClick={() => void player.select(client, page, item)}
            >
              <span aria-hidden="true">▶</span>
              <span className="audio-description">
                <strong title={item.title}>{item.title}</strong>
                <small title={[item.artist, item.album].filter(Boolean).join(" · ") || item.name}>
                  {[item.artist, item.album].filter(Boolean).join(" · ") || item.name}
                </small>
                {item.title !== item.name && (
                  <small className="audio-filename" title={item.name}>
                    {item.name}
                  </small>
                )}
              </span>
              <span className="audio-time">
                {item.durationMs === null ? "—" : audioTime(item.durationMs / 1000)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {page?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void load(page)}>
          {page.items.length ? "曲をもっと表示" : "続けて曲を探す"}
        </button>
      )}
      {page?.limitReached && (
        <p role="status">
          2,000曲まで表示しました。残りの項目はフォルダーを分けて確認してください。
        </p>
      )}
    </section>
  );
}
