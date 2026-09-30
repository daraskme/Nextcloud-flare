import { LoaderCircle } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { type Account, ApiError, errorMessage, type FileNode, formatBytes } from "../../lib/api";
import { uploads } from "./manager";

export function OverwriteDialog({
  node,
  account,
  parentId,
  onClose,
}: {
  node: FileNode;
  account: Account;
  parentId: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || pending) return;
    setPending(true);
    setFailure("");
    try {
      await uploads.enqueue(file, account, parentId, node);
      onClose();
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? errorMessage(error)
          : error instanceof Error
            ? error.message
            : "上書きを開始できません。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="ファイルを上書き"
      description={`「${node.name}」の内容を置き換えます。保存先の名前は変わりません。`}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="overwrite-summary">
          <span>現在のファイル</span>
          <strong>{node.name}</strong>
          <span>{node.size === null ? "サイズ不明" : formatBytes(node.size)}</span>
        </div>
        <label className="field-label" htmlFor={inputId}>
          上書きするファイル
        </label>
        <input
          id={inputId}
          ref={input}
          type="file"
          hidden
          disabled={pending}
          onChange={(event) => {
            setFile(event.target.files?.[0]);
            setFailure("");
          }}
        />
        <Button
          autoFocus
          className="overwrite-picker"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          ファイルを選択
        </Button>
        {file && (
          <p className="overwrite-source">
            {file.name} · {formatBytes(file.size)}
          </p>
        )}
        <p className="overwrite-note">
          確認後に保存先が更新された場合は停止します。再開には、ここで選んだ元のファイルが必要です。
        </p>
        {failure && (
          <p role="alert" className="form-error">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" disabled={!file || pending}>
            {pending && <LoaderCircle className="spin" size={16} />}
            上書きを開始
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
