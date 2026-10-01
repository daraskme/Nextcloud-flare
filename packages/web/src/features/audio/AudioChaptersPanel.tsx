import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  ApiError,
  type AudioChapter,
  type AudioChapterSet,
  type AudioTrack,
  api,
  errorMessage,
} from "../../lib/api";
import {
  audioChaptersDirty,
  formatChapterTime,
  matchesAudioChapterSelection,
  moveAudioChapter,
  parseChapterTime,
  removeAudioChapter,
  updateAudioChapter,
  validAudioChapters,
} from "./audioChapters";

function ChapterTime({
  chapter,
  durationMs,
  disabled,
  onChange,
}: {
  chapter: AudioChapter;
  durationMs: number;
  disabled: boolean;
  onChange: (positionMs: number) => void;
}) {
  const [value, setValue] = useState(() => formatChapterTime(chapter.positionMs));
  useEffect(() => setValue(formatChapterTime(chapter.positionMs)), [chapter.positionMs]);
  const commit = () => {
    const parsed = parseChapterTime(value);
    if (parsed === null || parsed > durationMs) {
      setValue(formatChapterTime(chapter.positionMs));
      return;
    }
    onChange(parsed);
  };
  return (
    <input
      className="audio-chapter-time"
      aria-label={`チャプター「${chapter.title || "無題"}」の時刻`}
      inputMode="decimal"
      disabled={disabled}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setValue(formatChapterTime(chapter.positionMs));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function AudioChaptersPanel({
  track,
  currentPositionMs,
  seek,
  close,
}: {
  track: AudioTrack;
  currentPositionMs: () => number | null;
  seek: (positionMs: number) => void;
  close: () => void;
}) {
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [saved, setSaved] = useState<AudioChapterSet | null>(null);
  const [draft, setDraft] = useState<AudioChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const selected = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await api.audioChapters(track.id, controller.signal);
      if (
        controller.signal.aborted ||
        !matchesAudioChapterSelection(
          selected,
          generation.current,
          track.id,
          track.currentBlobId,
          value,
        )
      )
        return;
      setSaved(value);
      setDraft(value.chapters.map((chapter) => ({ ...chapter })));
      setConflict(false);
    } catch (caught) {
      if (!controller.signal.aborted && selected === generation.current)
        setError(errorMessage(caught));
    } finally {
      if (!controller.signal.aborted && selected === generation.current) setLoading(false);
    }
  }, [track.currentBlobId, track.id]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [load]);

  const dirty = saved !== null && audioChaptersDirty(saved.chapters, draft);
  const valid = saved !== null && validAudioChapters(draft, saved.durationMs);
  const capture = () => {
    const positionMs = currentPositionMs();
    if (positionMs === null || !saved || draft.length >= 200) return;
    const chapter: AudioChapter = {
      id: crypto.randomUUID(),
      positionMs: Math.min(positionMs, saved.durationMs),
      title: `チャプター ${draft.length + 1}`,
    };
    setDraft((value) => [...value, chapter]);
  };
  const save = async () => {
    if (!saved || !dirty || !valid) return;
    const selected = generation.current;
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const value = await api.writeAudioChapters(track.id, saved.blobId, saved.revision, draft);
      if (
        !matchesAudioChapterSelection(
          selected,
          generation.current,
          track.id,
          track.currentBlobId,
          value,
        )
      )
        return;
      setSaved(value);
      setDraft(value.chapters.map((chapter) => ({ ...chapter })));
    } catch (caught) {
      if (selected !== generation.current) return;
      if (caught instanceof ApiError && caught.status === 409) setConflict(true);
      else setError(errorMessage(caught));
    } finally {
      if (selected === generation.current) setSaving(false);
    }
  };

  return (
    <section className="audio-chapters" aria-label="オーディオチャプター設定">
      <header>
        <div>
          <strong>チャプター設定</strong>
          <small>{track.title}</small>
        </div>
        <Button variant="ghost" size="icon" aria-label="チャプター設定を閉じる" onClick={close}>
          <X size={17} />
        </Button>
      </header>
      {loading ? (
        <div className="audio-chapter-status" role="status">
          <LoaderCircle size={18} className="spin" />
          チャプターを読み込んでいます
        </div>
      ) : (
        <>
          {error && (
            <div className="notice" role="alert">
              {error}
              <Button variant="ghost" onClick={() => void load()}>
                <RefreshCw size={15} />
                読み直す
              </Button>
            </div>
          )}
          {conflict && (
            <div className="notice" role="alert">
              別の場所でチャプターが更新されました。
              <Button onClick={() => void load()}>
                <RefreshCw size={15} />
                競合を読み直す
              </Button>
            </div>
          )}
          <div className="audio-chapter-actions">
            <Button onClick={capture} disabled={!saved || draft.length >= 200 || saving}>
              <Plus size={16} />
              現在位置をキャプチャ
            </Button>
            <span role="status">
              {dirty ? "未保存の変更があります" : `${draft.length} 件のチャプター`}
            </span>
          </div>
          {!draft.length ? (
            <p className="audio-chapter-empty">現在位置をキャプチャして追加できます。</p>
          ) : (
            <ol className="audio-chapter-list">
              {draft.map((chapter, index) => (
                <li key={chapter.id}>
                  <span className="audio-chapter-number">{index + 1}</span>
                  <input
                    className="audio-chapter-title"
                    aria-label={`チャプター ${index + 1} のタイトル`}
                    value={chapter.title}
                    maxLength={256}
                    disabled={saving}
                    onChange={(event) =>
                      setDraft((value) =>
                        updateAudioChapter(value, chapter.id, { title: event.target.value }),
                      )
                    }
                  />
                  <ChapterTime
                    chapter={chapter}
                    durationMs={saved?.durationMs ?? 0}
                    disabled={saving}
                    onChange={(positionMs) =>
                      setDraft((value) => updateAudioChapter(value, chapter.id, { positionMs }))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`チャプター ${index + 1} に移動`}
                    disabled={saving}
                    onClick={() => seek(chapter.positionMs)}
                  >
                    <MapPin size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`チャプター ${index + 1} を上へ`}
                    disabled={saving || index === 0}
                    onClick={() => setDraft((value) => moveAudioChapter(value, chapter.id, -1))}
                  >
                    <ArrowUp size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`チャプター ${index + 1} を下へ`}
                    disabled={saving || index === draft.length - 1}
                    onClick={() => setDraft((value) => moveAudioChapter(value, chapter.id, 1))}
                  >
                    <ArrowDown size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`チャプター ${index + 1} を削除`}
                    disabled={saving}
                    onClick={() => setDraft((value) => removeAudioChapter(value, chapter.id))}
                  >
                    <Trash2 size={15} />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <footer>
            <Button
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => saved && setDraft(saved.chapters.map((chapter) => ({ ...chapter })))}
            >
              キャンセル
            </Button>
            <Button disabled={!dirty || !valid || saving || conflict} onClick={() => void save()}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
              チャプターを保存
            </Button>
          </footer>
        </>
      )}
    </section>
  );
}
