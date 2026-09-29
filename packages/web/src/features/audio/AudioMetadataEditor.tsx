import { useEffect, useRef, useState } from "react";
import type { AudioPage, AudioTags, AudioTrack } from "../../../../shared/src/audio";
import type { AudioClient } from "../../public-share/audioClient";
import "./metadata.css";

const labels = { title: "曲名", artist: "アーティスト", album: "アルバム" };
export function AudioMetadataEditor({
  client,
  id,
  close,
  saved,
}: {
  client: AudioClient;
  id: string;
  close(): void;
  saved(page: AudioPage): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<AbortController | null>(null);
  const [current, setCurrent] = useState<{ item: AudioTrack; generator: string } | null>(null);
  const [tags, setTags] = useState<AudioTags>({ title: null, artist: null, album: null });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [stale, setStale] = useState(false);
  const begin = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    return AbortSignal.any([controller.signal, client.signal]);
  };
  const load = async () => {
    const signal = begin();
    setBusy(true);
    setMessage("");
    setCurrent(null);
    try {
      const page = await client.current(id, signal);
      signal.throwIfAborted();
      const item = page.items.find((item) => item.id === id);
      if (!page.canEdit || !item?.metadata) throw new Error("unavailable");
      setCurrent({ item, generator: page.generator });
      setTags(item.metadata.overrides);
      setStale(false);
    } catch {
      if (!signal.aborted)
        setMessage("タグを取得できません。編集権限や原本が変更されている可能性があります。");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    const abort = () => close();
    client.signal.addEventListener("abort", abort, { once: true });
    return () => {
      request.current?.abort();
      client.signal.removeEventListener("abort", abort);
    };
  }, [client, id]);
  const submit = async () => {
    if (!current?.item.metadata || !client.edit || busy || stale) return;
    if (
      Object.values(tags).some(
        (value) =>
          value !== null &&
          (/[\p{Cc}\p{Cs}]/u.test(value) ||
            new TextEncoder().encode(value.normalize("NFC").trim()).length > 1024),
      )
    ) {
      setMessage("各項目はUTF-8で1,024バイト以内にしてください。改行や制御文字は使えません。");
      return;
    }
    const signal = begin();
    setBusy(true);
    setMessage("");
    try {
      await client.edit(
        id,
        crypto.randomUUID(),
        {
          blobId: current.item.currentBlobId,
          generator: current.generator,
          revision: current.item.metadata.revision,
          ...tags,
        },
        signal,
      );
      const page = await client.current(id, signal);
      signal.throwIfAborted();
      if (
        !page.canEdit ||
        !page.items.some(
          (item) => item.id === id && item.currentBlobId === current.item.currentBlobId,
        )
      )
        throw new Error("unavailable");
      saved(page);
    } catch (error) {
      if (signal.aborted) return;
      setStale(true);
      const status = (error as { status?: number }).status;
      setMessage(
        status === 409
          ? "別の変更が先に保存されました。現在のタグを読み直してください。"
          : status === 423
            ? "このファイルはロックされています。解除後に読み直してください。"
            : "保存結果を確認できませんでした。現在のタグを読み直して確認してください。",
      );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <dialog
      className="audio-metadata-editor"
      ref={dialog}
      aria-labelledby="audio-edit-title"
      onCancel={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="audio-edit-title">音声タグを編集</h2>
        <p>空欄にすると原本から取得した値に戻ります。原本ファイルは変更しません。</p>
        {busy && <p role="status">処理しています…</p>}
        {current && (
          <>
            <p className="audio-edit-filename">{current.item.name}</p>
            {(Object.keys(labels) as (keyof AudioTags)[]).map((key) => (
              <label key={key}>
                {labels[key]}
                <input
                  name={key}
                  value={tags[key] ?? ""}
                  placeholder={
                    current.item.metadata?.extracted[key] ??
                    (key === "title" ? current.item.name : "未設定")
                  }
                  disabled={busy || stale}
                  onChange={(e) => setTags({ ...tags, [key]: e.target.value || null })}
                />
              </label>
            ))}
            <button
              type="button"
              disabled={busy || stale}
              onClick={() => setTags({ title: null, artist: null, album: null })}
            >
              すべて原本の値に戻す
            </button>
          </>
        )}
        {message && <p role="alert">{message}</p>}
        <div className="audio-edit-actions">
          <button type="button" onClick={close}>
            閉じる
          </button>
          {(!current || stale) && (
            <button type="button" disabled={busy} onClick={() => void load()}>
              現在のタグを読み直す
            </button>
          )}
          <button type="submit" disabled={!current || busy || stale}>
            タグを保存
          </button>
        </div>
      </form>
    </dialog>
  );
}
