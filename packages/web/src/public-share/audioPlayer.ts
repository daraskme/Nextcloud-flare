import type { AudioPage, AudioTrack } from "../../../shared/src/audio";
import type { AudioClient } from "./audioClient";

export interface AudioSnapshot {
  track: AudioTrack | null;
  scope: string;
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  volume: number;
  message: string;
  reload: boolean;
  previous: boolean;
  next: boolean;
}
interface AudioSelection {
  scope: string;
  trackId: string | null;
}
interface Session {
  client: AudioClient;
  item: AudioTrack;
  generator: string;
  stop: AbortController;
  removeLifetime: () => void;
  loaded: boolean;
  updatedAt: number | null;
  saved: number | null;
  pending: number | null;
  saving?: Promise<void> | undefined;
  blocked: boolean;
  checking: boolean;
  renewal?: Promise<void> | undefined;
  expiresAt: number;
  expiry?: ReturnType<typeof setTimeout>;
}
const empty = (): AudioSnapshot => ({
  track: null,
  scope: "",
  playing: false,
  loading: false,
  position: 0,
  duration: 0,
  volume: 1,
  message: "",
  reload: false,
  previous: false,
  next: false,
});
export function audioDenied(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    [401, 403, 404, 410].includes(Number(error.status))
  );
}

/** One native element lives outside route content. No original is copied into a Blob URL. */
export class AudioPlayer {
  #snapshot = empty();
  #selection: AudioSelection = { scope: "", trackId: null };
  #listeners = new Set<() => void>();
  #session: Session | null = null;
  #retiring = new Set<Session>();
  #settling: Promise<void> = Promise.resolve();
  #sequence = 0;
  #queue: AudioTrack[] = [];
  #timer: ReturnType<typeof setInterval>;
  #events = new AbortController();

  constructor(readonly media: HTMLAudioElement) {
    media.preload = "metadata";
    media.crossOrigin = "use-credentials";
    const on = (name: string, callback: () => void) =>
      media.addEventListener(name, callback, { signal: this.#events.signal });
    on("timeupdate", () => this.#time());
    on("durationchange", () => this.#time());
    on("playing", () => {
      if (this.#session?.loaded) this.#patch({ playing: true, loading: false });
    });
    on("pause", () => {
      this.#patch({ playing: false });
      const s = this.#session;
      if (s && !media.ended) void this.#save(s, this.#position(s));
    });
    on("ended", () => {
      const s = this.#session;
      if (!s) return;
      this.#patch({ playing: false });
      const sequence = this.#sequence;
      void this.#save(s, 0).then(() => {
        if (sequence === this.#sequence && this.#snapshot.next) void this.skip(1);
      });
    });
    on("error", () => {
      if (this.#session && media.getAttribute("src")) {
        media.pause();
        this.#patch({
          loading: false,
          message: "この音声を再生できません。原本をダウンロードして開けます。",
        });
      }
    });
    this.#timer = setInterval(() => {
      void this.#checkpoint();
    }, 15000);
  }
  getSnapshot = () => this.#snapshot;
  // List rows only depend on the selected track, not native playback time updates.
  getSelectionSnapshot = () => this.#selection;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #patch(value: Partial<AudioSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...value };
    const { scope, track } = this.#snapshot;
    const trackId = track?.id ?? null;
    if (scope !== this.#selection.scope || trackId !== this.#selection.trackId)
      this.#selection = { scope, trackId };
    for (const listener of this.#listeners) listener();
  }
  #live(s: Session) {
    return this.#session === s && !s.stop.signal.aborted;
  }
  #position(s: Session) {
    if (this.media.ended) return 0;
    const position = Math.max(0, Math.round((this.media.currentTime || 0) * 1000));
    return s.item.durationMs === null ? position : Math.min(position, s.item.durationMs);
  }
  #time() {
    if (!this.#session?.loaded) return;
    this.#patch({
      position: this.media.currentTime || 0,
      duration: Number.isFinite(this.media.duration)
        ? this.media.duration
        : (this.#session.item.durationMs ?? 0) / 1000,
    });
  }
  #clearMedia() {
    this.media.pause();
    this.media.removeAttribute("src");
    this.media.load();
  }
  #release(s: Session) {
    clearTimeout(s.expiry);
    s.removeLifetime();
    s.stop.abort();
    this.#retiring.delete(s);
  }
  #detach(save: boolean) {
    const s = this.#session;
    const position = s && !this.media.ended ? this.#position(s) : 0;
    this.#session = null;
    this.#clearMedia();
    if (!s) return;
    clearTimeout(s.expiry);
    if (!save) {
      this.#release(s);
      return;
    }
    this.#retiring.add(s);
    const saving = this.#save(s, position).finally(() => this.#release(s));
    this.#settling = Promise.all([this.#settling, saving]).then(() => {});
  }
  close(save = true) {
    ++this.#sequence;
    this.#detach(save);
    if (!save) for (const s of this.#retiring) this.#release(s);
    this.#queue = [];
    this.#url = null;
    this.#patch({ ...empty(), volume: this.media.volume });
    return this.#settling;
  }
  dispose() {
    void this.close(false);
    clearInterval(this.#timer);
    this.#events.abort();
    this.#listeners.clear();
  }
  updateQueue(client: AudioClient, page: AudioPage) {
    const s = this.#session;
    if (s?.client.scope !== client.scope || s.generator !== page.generator) return;
    this.#queue = page.items.slice(0, 2000);
    this.#navigation();
  }
  #navigation() {
    const index = this.#queue.findIndex((x) => x.id === this.#session?.item.id);
    this.#patch({ previous: index > 0, next: index >= 0 && index < this.#queue.length - 1 });
  }
  async select(
    client: AudioClient,
    page: Pick<AudioPage, "generator" | "items">,
    item: AudioTrack,
  ) {
    const sequence = ++this.#sequence;
    this.#detach(true);
    this.#queue = page.items.slice(0, 2000);
    const stop = new AbortController();
    const aborted = () => {
      if (this.#session === s) void this.close(false);
      else stop.abort();
    };
    const s: Session = {
      client,
      item,
      generator: page.generator,
      stop,
      loaded: false,
      removeLifetime: () => client.signal.removeEventListener("abort", aborted),
      updatedAt: null,
      saved: null,
      pending: null,
      blocked: false,
      checking: false,
      expiresAt: 0,
    };
    this.#session = s;
    this.#patch({
      ...empty(),
      track: item,
      scope: client.scope,
      loading: true,
      volume: this.media.volume,
    });
    this.#navigation();
    client.signal.addEventListener("abort", aborted, { once: true });
    if (client.signal.aborted) {
      aborted();
      return;
    }
    try {
      await this.#settling;
      if (sequence !== this.#sequence || !this.#live(s)) return;
      const current = await this.#current(s);
      if (!this.#live(s)) return;
      s.item = current;
      s.updatedAt = current.playback?.updatedAt ?? null;
      s.saved = current.playback?.positionMs ?? null;
      this.#patch({ track: current });
      await this.#renew(s);
      if (!this.#live(s)) return;
      if (!this.media.canPlayType(current.mime)) throw new Error("unsupported_audio");
      const ready = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.media.removeEventListener("loadedmetadata", loaded);
          this.media.removeEventListener("error", failed);
          stop.signal.removeEventListener("abort", cancelled);
          clearTimeout(timeout);
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error("audio_decode"));
        };
        const cancelled = () => {
          cleanup();
          reject(stop.signal.reason);
        };
        const timeout = setTimeout(failed, 30000);
        this.media.addEventListener("loadedmetadata", loaded, { once: true });
        this.media.addEventListener("error", failed, { once: true });
        stop.signal.addEventListener("abort", cancelled, { once: true });
      });
      this.media.src = this.#url!;
      this.media.load();
      await ready;
      if (!this.#live(s)) return;
      const duration = Number.isFinite(this.media.duration)
        ? this.media.duration
        : (current.durationMs ?? 0) / 1000;
      const position = (current.playback?.positionMs ?? 0) / 1000;
      this.media.currentTime = duration > 0 && position >= duration ? 0 : position;
      s.loaded = true;
      this.#time();
      await this.#play(s);
    } catch (error) {
      if (!this.#live(s)) return;
      if (audioDenied(error)) {
        void this.close(false);
        return;
      }
      this.#patch({
        loading: false,
        message: "音声を開けませんでした。再試行するか、原本をダウンロードしてください。",
      });
    }
  }
  async #current(s: Session) {
    const page = await s.client.current(s.item.id, s.stop.signal);
    const item = page.items.find(
      (x) => x.id === s.item.id && x.currentBlobId === s.item.currentBlobId,
    );
    if (!item || page.generator !== s.generator) throw { status: 404 };
    return item;
  }
  #url: string | null = null;
  async #renew(s: Session) {
    if (s.renewal) return s.renewal;
    s.renewal = (async () => {
      const result = await s.client.original(s.item, s.stop.signal);
      if (!this.#live(s)) return;
      this.#url = result.url;
      s.expiresAt = result.expiresAt;
      clearTimeout(s.expiry);
      s.expiry = setTimeout(
        () => {
          if (!this.#live(s)) return;
          // Removing src also discards buffered originals after the receipt expires.
          void this.close(false);
          this.#patch({ message: "再生の有効期限が切れました。一覧から曲を開き直してください。" });
        },
        Math.max(0, s.expiresAt - Date.now()),
      );
    })().finally(() => {
      s.renewal = undefined;
    });
    return s.renewal;
  }
  async #play(s: Session) {
    try {
      await this.media.play();
      if (!this.#live(s)) return;
      this.#patch({
        playing: !this.media.paused,
        loading: false,
        message: this.#snapshot.reload ? this.#snapshot.message : "",
      });
    } catch {
      if (this.#live(s))
        this.#patch({
          loading: false,
          playing: false,
          message: "再生ボタンを押してください。再生できない場合は原本をダウンロードできます。",
        });
    }
  }
  async toggle() {
    const s = this.#session;
    if (!s || this.#snapshot.loading) return;
    if (!this.media.paused) {
      this.media.pause();
      return;
    }
    if (!s.loaded) {
      await this.reload();
      return;
    }
    this.#patch({ loading: true });
    try {
      await this.#current(s);
      if (!this.#live(s)) return;
      if (s.expiresAt - Date.now() <= 30000) await this.#renew(s);
      if (this.#live(s)) await this.#play(s);
    } catch (error) {
      if (!this.#live(s)) return;
      if (audioDenied(error)) {
        void this.close(false);
        return;
      }
      this.#patch({
        loading: false,
        message: "再生を再開できませんでした。接続を確認して再試行してください。",
      });
    }
  }
  async reload() {
    const s = this.#session;
    if (s) await this.select(s.client, { generator: s.generator, items: this.#queue }, s.item);
  }
  async skip(delta: number) {
    const s = this.#session;
    const index = this.#queue.findIndex((x) => x.id === s?.item.id);
    const next = this.#queue[index + delta];
    if (s && index >= 0 && next)
      await this.select(s.client, { generator: s.generator, items: this.#queue }, next);
  }
  volume(value: number) {
    this.media.volume = Math.max(0, Math.min(1, value));
    this.#patch({ volume: this.media.volume });
  }
  flush() {
    const s = this.#session;
    return s ? this.#save(s, this.#position(s)) : Promise.resolve();
  }
  #save(s: Session, position: number): Promise<void> {
    if (!s.client.save || !s.loaded || s.blocked || s.stop.signal.aborted)
      return s.saving ?? Promise.resolve();
    s.pending = position;
    if (s.saving) return s.saving;
    s.saving = (async () => {
      while (s.pending !== null && !s.blocked && !s.stop.signal.aborted) {
        const position = s.pending;
        s.pending = null;
        if (position === s.saved) continue;
        try {
          const result = await s.client.save!(
            s.item,
            s.generator,
            position,
            s.updatedAt,
            s.stop.signal,
          );
          if (s.stop.signal.aborted) return;
          if (
            result.positionMs !== position ||
            !Number.isSafeInteger(result.updatedAt) ||
            result.updatedAt <= (s.updatedAt ?? 0)
          )
            throw new Error("invalid_playback_receipt");
          s.updatedAt = result.updatedAt;
          s.saved = position;
        } catch (error) {
          s.blocked = true;
          if (!this.#live(s)) return;
          if (audioDenied(error)) {
            void this.close(false);
            return;
          }
          const conflict =
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 409;
          this.#patch({
            reload: true,
            message: conflict
              ? "別の画面で再生位置が更新されました。保存済みの位置を確認して再開してください。"
              : "再生位置の保存を確認できませんでした。保存済みの位置を確認して再開してください。",
          });
        }
      }
    })().finally(() => {
      s.saving = undefined;
    });
    return s.saving;
  }
  async #checkpoint() {
    const s = this.#session;
    if (!s || !s.loaded || this.media.paused || s.checking) return;
    s.checking = true;
    try {
      // Even completely buffered public audio must revalidate its live sharing grant.
      await this.#current(s);
      if (!this.#live(s)) return;
      if (s.expiresAt - Date.now() <= 30000) await this.#renew(s);
      if (this.#live(s)) await this.#save(s, this.#position(s));
    } catch (error) {
      if (!this.#live(s)) return;
      if (audioDenied(error)) {
        void this.close(false);
        return;
      }
      this.media.pause();
      this.#patch({
        message: "再生の接続を確認できませんでした。接続を確認して再開してください。",
      });
    } finally {
      s.checking = false;
    }
  }
  async download(target: Window) {
    const s = this.#session;
    if (!s) {
      target.close();
      return;
    }
    try {
      await this.#current(s);
      await this.#renew(s);
      if (!this.#live(s) || !this.#url) {
        target.close();
        return;
      }
      target.location.replace(`${this.#url}?download=1`);
    } catch (error) {
      target.close();
      if (!this.#live(s)) return;
      if (audioDenied(error)) {
        void this.close(false);
        return;
      }
      this.#patch({ message: "ダウンロードを開始できませんでした。再試行してください。" });
    }
  }
}
