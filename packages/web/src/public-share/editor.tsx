import { useEffect, useRef, useState } from "react";
import { type EditIntent, type PublicClient, PublicError, type SharedNode } from "./client";

export function PublicEditor({
  client,
  sessionId,
  parentId,
  node,
  close,
  done,
  failed,
}: {
  client: PublicClient;
  sessionId: string;
  parentId: string;
  node?: SharedNode | undefined;
  close: () => void;
  done: () => void;
  failed: (error: unknown) => void;
}) {
  const [name, setName] = useState(node?.name ?? "");
  const [pending, setPending] = useState<{
    intent: EditIntent;
    operationId?: string | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(false),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  async function submit() {
    if (active.current) return;
    const intent = pending?.intent ?? {
      key: crypto.randomUUID(),
      sessionId,
      suffix: node ? `/nodes/${encodeURIComponent(node.id)}` : "/nodes",
      method: node ? ("PATCH" as const) : ("POST" as const),
      body: node ? { name } : { kind: "folder" as const, parentId, name },
    };
    active.current = true;
    setBusy(true);
    setMessage("");
    try {
      const operation = pending?.operationId
        ? await client.operation(pending.operationId, intent.sessionId)
        : await client.edit(intent);
      if (
        !/^op_[a-f0-9]{64}$/.test(operation.id) ||
        !["claimed", "committed", "failed"].includes(operation.state)
      )
        throw new Error("invalid_operation_receipt");
      if (operation.state === "claimed") {
        setPending({ intent, operationId: operation.id });
        setMessage("処理の完了を確認できません。少し待ってから結果を確認してください。");
      } else if (operation.state === "committed") {
        done();
      } else {
        setPending(null);
        setMessage("操作は完了しませんでした。名前やフォルダーの状態を確認してください。");
      }
    } catch (error) {
      if (client.lifetime.signal.aborted) return;
      if (error instanceof PublicError && [401, 403, 404, 412].includes(error.status)) {
        // Never replay with a new credential, nor turn a hidden receipt into a fresh operation.
        failed(error);
      } else if (!(error instanceof PublicError) || error.status >= 500 || pending) {
        setPending({
          intent,
          operationId:
            error instanceof PublicError
              ? (error.operationId ?? pending?.operationId)
              : pending?.operationId,
        });
        setMessage(
          "結果を確認できませんでした。この画面を開いたまま「結果を確認」を押してください。元と同じ操作を確認・再送します。",
        );
      } else {
        setMessage(
          error.status === 423
            ? "この項目はロックされています。解除後にお試しください。"
            : error.status === 409
              ? "同じ名前の項目があるか、別の操作と競合しています。名前を確認してください。"
              : error.status === 429
                ? "しばらく待ってから、もう一度お試しください。"
                : "名前を確認してください。使用できない文字や長すぎる名前は保存できません。",
        );
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="public-editor" aria-label={node ? "名前を変更" : "新規フォルダー"}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{node ? "名前を変更" : "新規フォルダー"}</h2>
        <label htmlFor="edit-name">名前</label>
        <input
          id="edit-name"
          ref={input}
          value={name}
          required
          maxLength={255}
          disabled={busy || !!pending}
          onChange={(event) => setName(event.target.value)}
        />
        {message && <p role="alert">{message}</p>}
        {pending && (
          <p>
            この画面を閉じると結果の確認を終了します。操作は取り消されません。再度作成する前に、フォルダーの内容を確認してください。
          </p>
        )}
        <div className="editor-actions">
          <button className="quiet" type="button" disabled={busy} onClick={close}>
            {pending ? "確認を終了" : "キャンセル"}
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "確認中…" : pending ? "結果を確認" : node ? "名前を保存" : "フォルダーを作成"}
          </button>
        </div>
      </form>
    </section>
  );
}
