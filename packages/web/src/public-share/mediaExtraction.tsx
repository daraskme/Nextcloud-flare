import { useEffect, useRef, useState } from "react";
import {
  type MediaExtractionReceipt,
  mediaExtractionReceipt,
} from "../../../shared/src/mediaExtraction";
import "./mediaExtraction.css";

/** Mount with a key containing the credential scope and original tuple. */
export function MediaExtraction({
  node,
  request,
  close,
}: {
  node: { id: string; currentBlobId: string | null; name: string };
  request: (key: string, signal: AbortSignal) => Promise<unknown>;
  close: () => void;
}) {
  const [receipt, setReceipt] = useState<MediaExtractionReceipt | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID()),
    stop = useRef(new AbortController()),
    running = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    return () => controller.abort();
  }, []);
  const run = async () => {
    const current = stop.current;
    if (running.current || current.signal.aborted || !node.currentBlobId) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request(key.current, current.signal);
      current.signal.throwIfAborted();
      setReceipt(mediaExtractionReceipt(result, node.id, node.currentBlobId));
    } catch (e) {
      if (current.signal.aborted) return;
      setReceipt(null);
      const status = (e as { status?: number })?.status;
      setError(
        [401, 403, 404, 409, 412].includes(status ?? 0)
          ? "閲覧権限またはファイルの状態が変わりました。ファイル一覧を開き直してください。"
          : "読み込みの状態を確認できませんでした。もう一度確認してください。",
      );
    } finally {
      if (!current.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="media-extraction" aria-label="メディア情報の読み込み">
      <p className="media-extraction-name">{node.name}</p>
      <p>原本から曲名・形式・画像の大きさなどを読み込みます。</p>
      {receipt && (
        <p role="status">
          {receipt.state === "pending"
            ? "メディア情報を読み込んでいます。しばらくして確認してください。"
            : receipt.state === "ready"
              ? `読み込みが完了しました。${receipt.kind === "audio" ? "オーディオ" : "ギャラリー"}で表示できます。`
              : receipt.state === "unsupported"
                ? "このファイルから対応するメディア情報を読み取れませんでした。"
                : "メディア情報を読み込めませんでした。"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="media-extraction-actions">
        {(!receipt || receipt.state === "pending") && (
          <button type="button" disabled={busy || !node.currentBlobId} onClick={() => void run()}>
            {busy ? "確認中…" : receipt || error ? "状態を確認" : "メディア情報を読み込む"}
          </button>
        )}
        <button type="button" onClick={close}>
          閉じる
        </button>
      </div>
    </section>
  );
}
