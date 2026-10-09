import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, api, errorMessage, type TrashItem } from "../../lib/api";

export function EmptyTrashDialog({
  account,
  close,
  refresh,
}: {
  account: Account;
  close: () => void;
  refresh: () => void;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(0);
  const [keys] = useState(() => new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const all: TrashItem[] = [];
      let cursor: string | null = null;
      do {
        const page = await api.trash(account.spaceId, cursor, controller.signal);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      if (!controller.signal.aborted) setItems(all);
    })().catch((error) => {
      if (!controller.signal.aborted) setFailure(errorMessage(error));
    });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [account.id, account.epoch]);
  const submit = async () => {
    if (!items || !confirmed || busy) return;
    setBusy(true);
    setFailure("");
    let index = done;
    try {
      for (; index < items.length; index++) {
        if (!alive.current) return;
        const item = items[index]!;
        if (!keys.has(item.opId)) keys.set(item.opId, crypto.randomUUID());
        await api.mutation(
          `/api/v1/trash/${encodeURIComponent(item.opId)}/purge`,
          "POST",
          { spaceId: account.spaceId },
          keys.get(item.opId)!,
        );
        setDone(index + 1);
      }
      refresh();
      close();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) keys.delete(items[index]!.opId);
      setFailure(`${items[index]?.name ?? "項目"}: ${errorMessage(error)}`);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="ゴミ箱を空にする"
      description="ごみ箱内のすべての項目を完全に削除します。この操作は取り消せません。"
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <p role="status">
        {items ? `${done} / ${items.length} 件を削除済み` : "削除する項目を確認しています…"}
      </p>
      <label className="confirm-delete">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        すべて完全に削除することを確認しました
      </label>
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={close}>
          閉じる
        </Button>
        <Button
          variant="danger"
          disabled={!items?.length || !confirmed || busy}
          onClick={() => void submit()}
        >
          {busy ? "削除中…" : "ゴミ箱を空にする"}
        </Button>
      </div>
    </Dialog>
  );
}
