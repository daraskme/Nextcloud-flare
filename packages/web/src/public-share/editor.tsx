import { useCallback, useEffect, useRef, useState } from "react";
import { type EditIntent, type PublicClient, PublicError, type SharedNode } from "./client";
import { editMessage, runPublicEdit } from "./edit";
import {
  editLock,
  editScope,
  loadPublicEdit,
  newPublicEdit,
  type PublicEditRecord,
  publicEditStore,
} from "./editStore";

export function PublicEditor({
  client,
  sessionId,
  expiresAt,
  parentId,
  request,
  close,
  done,
  failed,
  statusChanged,
}: {
  client: PublicClient;
  sessionId: string;
  expiresAt: number;
  parentId: string;
  request: { node?: SharedNode; remove?: boolean } | null;
  close: () => void;
  done: (notice: string) => void;
  failed: (error: unknown) => void;
  statusChanged: (state: { blocked: boolean; running: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<PublicEditRecord | null>(null);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [storageError, setStorageError] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null),
    alive = useRef(true),
    saved = useRef<PublicEditRecord | null>(null);
  const revision = useRef(0);
  const ownKey = useRef<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null),
    input = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ done, close, failed, statusChanged, request });
  callbacks.current = { done, close, failed, statusChanged, request };
  const scope = editScope(client.id, sessionId);
  const refresh = useCallback(async () => {
    const generation = ++revision.current;
    try {
      const record = (await loadPublicEdit(client.id, sessionId)) ?? null;
      client.lifetime.signal.throwIfAborted();
      if (!alive.current || generation !== revision.current) return;
      const previous = saved.current;
      saved.current = record;
      setPending(record);
      setReady(true);
      setStorageError(false);
      if (
        previous &&
        !record &&
        (!callbacks.current.request || previous.intent.key === ownKey.current)
      ) {
        callbacks.current.close();
        callbacks.current.done(
          "確認記録が更新されました。現在のフォルダーの内容を確認してください。",
        );
      }
    } catch (error) {
      if (alive.current && generation === revision.current && !client.lifetime.signal.aborted) {
        setReady(false);
        setStorageError(true);
        setMessage(editMessage(error));
      }
    }
  }, [client, sessionId]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const broadcast = new BroadcastChannel(editLock(scope));
    channel.current = broadcast;
    const sync = () => {
      if (!active.current) void refresh();
    };
    broadcast.onmessage = sync;
    window.addEventListener("focus", sync);
    return () => {
      alive.current = false;
      active.current?.abort();
      broadcast.close();
      channel.current = null;
      window.removeEventListener("focus", sync);
      callbacks.current.statusChanged({ blocked: false, running: false });
    };
  }, [refresh, scope]);
  useEffect(() => {
    statusChanged({ blocked: !ready || !!pending || busy, running: busy });
  }, [ready, pending, busy, statusChanged]);
  useEffect(() => {
    setName(request?.node?.name ?? "");
    if (!pending) {
      input.current?.focus();
      input.current?.select();
    }
  }, [request]);
  const changed = (record: PublicEditRecord | null) => {
    revision.current++;
    saved.current = record;
    if (alive.current) setPending(record);
    channel.current?.postMessage("changed");
  };
  const remove = pending ? pending.intent.method === "DELETE" : request?.remove === true;
  const rename = pending ? pending.intent.method === "PATCH" : !!request?.node && !remove;
  const title = remove ? "ごみ箱へ移動" : rename ? "名前を変更" : "新規フォルダー";
  const label = pending?.label ?? request?.node?.name ?? name;
  const kind = pending?.kind ?? request?.node?.kind;
  async function submit() {
    if (active.current || !ready || (!pending && !request)) return;
    const controller = new AbortController();
    revision.current++;
    active.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const intent: EditIntent = pending?.intent ?? {
        key: crypto.randomUUID(),
        sessionId,
        suffix: request?.node ? `/nodes/${request.node.id}` : "/nodes",
        method: remove ? "DELETE" : rename ? "PATCH" : "POST",
        body: remove
          ? { revision: request!.node!.revision }
          : rename
            ? { name }
            : { kind: "folder", parentId, name },
      };
      const record =
        pending ??
        newPublicEdit(client.id, expiresAt, label, kind === "file" ? "file" : "folder", intent);
      if (!pending) ownKey.current = record.intent.key;
      const result = await runPublicEdit(
        client,
        record,
        pending ? "check" : "new",
        controller.signal,
        changed,
      );
      if (!alive.current) return;
      if (result.state === "claimed")
        setMessage("処理の完了を確認できません。少し待ってから結果を確認してください。");
      else {
        const notice =
          result.state === "committed"
            ? "操作の完了を確認しました。"
            : "操作は完了しませんでした。現在の内容を確認してください。";
        if (!request || ownKey.current === record.intent.key) {
          close();
          done(notice);
        } else setMessage(notice);
      }
    } catch (error) {
      if (!alive.current || client.lifetime.signal.aborted) return;
      if (error instanceof PublicError && [401, 403, 404, 412].includes(error.status))
        failed(error);
      else setMessage(editMessage(error, remove));
    } finally {
      active.current = null;
      if (alive.current && !client.lifetime.signal.aborted) {
        await refresh();
        setBusy(false);
      }
    }
  }
  async function discard() {
    if (
      active.current ||
      !window.confirm(
        "確認記録を削除すると、この操作の結果を追跡できなくなります。サーバー側の処理は取り消されません。新しい操作の前に一覧で結果を確認してください。記録を削除しますか？",
      )
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      if (!navigator.locks) throw new Error("このブラウザーは操作の安全な再開に対応していません。");
      await navigator.locks.request(editLock(scope), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("別のタブで操作中です。終了後に記録を削除してください。");
        client.lifetime.signal.throwIfAborted();
        controller.signal.throwIfAborted();
        // Compare a known record, so a stale tab cannot discard a different new operation.
        if (pending) await publicEditStore.remove(pending);
        else await publicEditStore.discard(scope);
      });
      if (!alive.current || client.lifetime.signal.aborted) return;
      changed(null);
      setStorageError(false);
      setReady(true);
      setMessage("");
      close();
      done("確認記録を削除しました。サーバー側の処理は取り消されません。");
    } catch (error) {
      if (alive.current) setMessage(editMessage(error));
    } finally {
      active.current = null;
      if (alive.current) setBusy(false);
    }
  }
  if (!request && !pending && !storageError) return null;
  return (
    <section className="public-editor" aria-label={storageError ? "操作の確認記録" : title}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{storageError ? "操作の確認記録" : title}</h2>
        {!storageError &&
          (remove ? (
            <p>
              「{label}」{kind === "folder" ? "と中の項目" : ""}
              を共有した方のごみ箱へ移動します。復元は共有した方に依頼してください。
            </p>
          ) : (
            <>
              {pending && rename && <p>名前の変更対象：{pending.label}</p>}
              <label htmlFor="edit-name">名前</label>
              <input
                id="edit-name"
                ref={input}
                value={pending && "name" in pending.intent.body ? pending.intent.body.name : name}
                required
                maxLength={255}
                disabled={busy || !!pending || !ready}
                onChange={(event) => setName(event.target.value)}
              />
            </>
          ))}
        {message && <p role="alert">{message}</p>}
        {pending && (
          <p>
            結果を確認できていない操作があります。再読み込み後も、元と同じ操作を確認・再送できます。自動送信はしません。
          </p>
        )}
        {pending && (
          <p>
            この操作を確認してから、次の編集を行ってください。記録の削除は操作の取消しではありません。
          </p>
        )}
        <div className="editor-actions">
          {pending || storageError ? (
            <button className="quiet" type="button" disabled={busy} onClick={() => void discard()}>
              記録を削除
            </button>
          ) : (
            <button className="quiet" type="button" disabled={busy} onClick={close}>
              キャンセル
            </button>
          )}
          {storageError ? (
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              確認記録を再読込
            </button>
          ) : (
            <button className="primary" type="submit" disabled={busy || !ready}>
              {busy
                ? "確認中…"
                : pending
                  ? "結果を確認"
                  : remove
                    ? "ごみ箱へ移動する"
                    : rename
                      ? "名前を保存"
                      : "フォルダーを作成"}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
