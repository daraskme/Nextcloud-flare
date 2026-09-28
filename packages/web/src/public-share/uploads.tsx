import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type PublicClient, PublicError, type SharedNode, type SharedRoot } from "./client";
import { transferPublicUpload, type UploadProgress, uploadMessage } from "./upload";
import {
  listPublicUploads,
  newPublicUpload,
  type PublicUploadRecord,
  publicUploadStore,
} from "./uploadStore";

interface Entry {
  record: PublicUploadRecord;
  file?: File;
  auto?: boolean;
}
export function PublicUploads({
  client,
  root,
  parentId,
  request,
  closeForm,
  changed,
  denied,
  busyChanged,
}: {
  client: PublicClient;
  root: SharedRoot;
  parentId: string | null;
  request: { node?: SharedNode } | null;
  closeForm: () => void;
  changed: (message: string) => void;
  denied: (error: unknown) => void;
  busyChanged: (busy: boolean) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [ready, setReady] = useState(false);
  const [file, setFile] = useState<File>(),
    [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false),
    [active, setActive] = useState<string | null>(null);
  const fileId = useId(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void listPublicUploads(client.id, root.sessionId)
      .then((rows) => {
        if (alive.current) {
          setEntries(rows.map((record) => ({ record })));
          setReady(true);
        }
      })
      .catch((error) => {
        if (alive.current) setMessage(uploadMessage(error));
      });
    return () => {
      alive.current = false;
    };
  }, [client, root.sessionId]);
  useEffect(() => {
    setFile(undefined);
  }, [request]);
  useEffect(() => {
    busyChanged(saving || active !== null);
  }, [saving, active, busyChanged]);
  async function start() {
    if (!ready || saving || active || !file || !request) return;
    setSaving(true);
    setMessage("");
    try {
      if (entries.length >= 32)
        throw new Error("待機中の送信は32件までです。先の送信を確認してください。");
      const record = await newPublicUpload(
        client.id,
        root.sessionId,
        root.expiresAt,
        parentId,
        file,
        request.node,
      );
      client.lifetime.signal.throwIfAborted();
      if (!alive.current) return;
      await publicUploadStore.save(record);
      client.lifetime.signal.throwIfAborted();
      if (!alive.current) return;
      setEntries((items) => [...items, { record, file, auto: true }]);
      closeForm();
    } catch (error) {
      if (alive.current) setMessage(uploadMessage(error));
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  return (
    <section className="public-uploads" aria-label="アップロード">
      {message && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
      {request && (
        <form
          className="public-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <h2>{request.node ? "ファイルを上書き" : "ファイルをアップロード"}</h2>
          {request.node && (
            <p>「{request.node.name}」の内容を置き換えます。保存先の名前は変わりません。</p>
          )}
          <label htmlFor={fileId}>{request.node ? "上書きするファイル" : "送信するファイル"}</label>
          <input
            key={request.node?.id ?? "new"}
            id={fileId}
            type="file"
            disabled={saving || active !== null}
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setMessage("");
            }}
          />
          {file && (
            <p className="upload-name">
              {file.name} · {file.size.toLocaleString()} bytes
            </p>
          )}
          <p>
            再読み込み後は元のファイルを選び直して再開できます。上書き先が更新された場合は送信を止めます。
          </p>
          <div className="editor-actions">
            <button className="quiet" type="button" disabled={saving} onClick={closeForm}>
              キャンセル
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!file || !ready || saving || active !== null}
            >
              {request.node ? "上書きを開始" : "アップロードを開始"}
            </button>
          </div>
        </form>
      )}
      {entries.map((entry) => (
        <PublicUploadTask
          key={entry.record.id}
          entry={entry}
          client={client}
          disabled={saving || (active !== null && active !== entry.record.id)}
          onBusy={(busy) => setActive(busy ? entry.record.id : null)}
          denied={denied}
          finished={(message) => {
            setEntries((items) => items.filter((item) => item.record.id !== entry.record.id));
            changed(message);
          }}
        />
      ))}
    </section>
  );
}

function PublicUploadTask({
  entry,
  client,
  disabled,
  onBusy,
  denied,
  finished,
}: {
  entry: Entry;
  client: PublicClient;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  denied: (error: unknown) => void;
  finished: (message: string) => void;
}) {
  const [file, setFile] = useState(entry.file);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<UploadProgress>({
    phase: "paused",
    bytes: 0,
    message: "元のファイルを選択して再開するか、保存済みの結果を確認できます。",
  });
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    started = useRef(false);
  const callbacks = useRef({ onBusy, denied, finished });
  callbacks.current = { onBusy, denied, finished };
  const inputId = useId();
  const run = useCallback(
    async (action: "continue" | "check" | "cancel") => {
      if (controller.current) return;
      const call = new AbortController();
      controller.current = call;
      setBusy(true);
      callbacks.current.onBusy(true);
      let terminal: UploadProgress | undefined;
      try {
        await transferPublicUpload(
          client,
          entry.record,
          action,
          action === "continue" ? file : undefined,
          call.signal,
          (next) => {
            if (mounted.current) setState(next);
            if (next.phase === "completed" || next.phase === "stopped") terminal = next;
          },
        );
      } catch (error) {
        if (!mounted.current || client.lifetime.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          phase: "paused",
          message: call.signal.aborted
            ? "通信を一時停止しました。サーバー側の処理は継続する場合があります。結果を確認してから再開・中止してください。"
            : action === "cancel" && error instanceof PublicError && error.status === 409
              ? "確定処理へ進んでいるため中止できません。結果を確認するか、再開して保存を確定してください。"
              : uploadMessage(error),
        }));
        if (error instanceof PublicError && [401, 403, 404, 412].includes(error.status))
          callbacks.current.denied(error);
      } finally {
        controller.current = null;
        if (mounted.current) {
          setBusy(false);
          callbacks.current.onBusy(false);
          if (terminal) callbacks.current.finished(terminal.message);
        }
      }
    },
    [client, entry.record, file],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (entry.auto && !started.current) {
      started.current = true;
      void run("continue");
    }
  }, [entry.auto, run]);
  async function forget() {
    if (
      !window.confirm(
        "記録の削除は送信の中止ではありません。再送前に一覧で結果を確認してください。転送記録を削除しますか？",
      )
    )
      return;
    try {
      await navigator.locks.request(
        `ncf-public-upload:${entry.record.id}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error("別のタブで送信中です。一時停止してから記録を削除してください。");
          await publicUploadStore.remove(entry.record.id);
        },
      );
      callbacks.current.finished("転送記録を削除しました。サーバー側の処理は取り消されません。");
    } catch (error) {
      setState((v) => ({ ...v, message: uploadMessage(error) }));
    }
  }
  return (
    <section className="public-editor upload-task" aria-label={`${entry.record.name}の送信`}>
      <h2 className="upload-name">
        {entry.record.target ? "上書き: " : "送信: "}
        {entry.record.name}
      </h2>
      <progress
        max={Math.max(1, entry.record.size)}
        value={state.bytes}
        aria-label="確認済みの送信量"
      />
      <p role="status" aria-live="polite">
        {state.message}
      </p>
      <p>
        {state.bytes.toLocaleString()} / {entry.record.size.toLocaleString()} bytes 確認済み
      </p>
      {!busy && (
        <>
          <label htmlFor={inputId}>再開する元のファイル</label>
          <input
            id={inputId}
            type="file"
            disabled={disabled}
            onChange={(event) => setFile(event.target.files?.[0])}
          />
          <p className="upload-name">選択中: {file?.name ?? "未選択"}</p>
        </>
      )}
      <div className="upload-actions">
        {busy ? (
          <button className="quiet" type="button" onClick={() => controller.current?.abort()}>
            送信を一時停止
          </button>
        ) : (
          <>
            <button
              className="primary"
              type="button"
              disabled={disabled}
              onClick={() => void run("check")}
            >
              結果を確認
            </button>
            <button
              className="quiet"
              type="button"
              disabled={disabled}
              onClick={() => void run("continue")}
            >
              再開する
            </button>
            <button
              className="quiet"
              type="button"
              disabled={disabled}
              onClick={() => void run("cancel")}
            >
              送信を中止
            </button>
            <button
              className="quiet"
              type="button"
              disabled={disabled}
              onClick={() => void forget()}
            >
              記録を削除
            </button>
          </>
        )}
      </div>
    </section>
  );
}
