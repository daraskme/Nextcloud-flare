import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { type Account, api, errorMessage, type FileNode } from "../../lib/api";
import { displayFiles, isTextFile } from "../../lib/decryptedFiles";
import {
  getEncryptionSession,
  isEncryptedFile,
  subscribeEncryptionSession,
} from "../../lib/encryptionSession";
import { FilePreview } from "../files/FilePreview";

export function PrivateNovels({ account }: { account: Account }) {
  const keys = useSyncExternalStore(subscribeEncryptionSession, () =>
    getEncryptionSession(account.id),
  );
  const [rows, setRows] = useState<{ source: FileNode; display: FileNode }[]>([]);
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState("");
  const [filter, setFilter] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setSelected(null);
    setBusy(true);
    setFailure("");
    void (async () => {
      const folders = [account.rootNodeId];
      const found: typeof rows = [];
      for (let index = 0; index < folders.length; index++) {
        let cursor: string | null = null;
        do {
          controller.signal.throwIfAborted();
          const page = await api.children(folders[index]!, cursor, controller.signal);
          const visible = new Map(
            (await displayFiles(account, page.children)).map((node) => [node.id, node]),
          );
          for (const source of page.children) {
            controller.signal.throwIfAborted();
            if (source.kind === "folder") {
              folders.push(source.id);
              continue;
            }
            if (isEncryptedFile(source) && !keys) continue;
            const display = visible.get(source.id) ?? source;
            if (isEncryptedFile(source) && display === source && keys)
              setFailure(
                "一部の暗号化ファイルを確認できません。鍵と接続を確認して更新してください。",
              );
            if (isTextFile(display)) found.push({ source, display });
          }
          controller.signal.throwIfAborted();
          setRows([...found].sort((a, b) => a.display.name.localeCompare(b.display.name, "ja")));
          cursor = page.nextCursor;
        } while (cursor);
      }
    })()
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [account.id, account.epoch, keys, reload]);
  return (
    <section aria-label="小説一覧">
      <div className="reader-toolbar">
        <label>
          小説を検索 <input value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <Button onClick={() => setReload((value) => value + 1)}>一覧を更新</Button>
      </div>
      {!keys && account.clientEncryptionRequired && (
        <p>暗号化されたテキストは鍵を解除すると表示されます。</p>
      )}
      {busy && <p role="status">フォルダー内のテキストを探しています…</p>}
      {failure && <p role="alert">{failure}</p>}
      {!busy && !rows.length && (
        <p>テキストファイル（.txt・.text）をアップロードすると、ここに表示されます。</p>
      )}
      <div className="novel-list">
        {rows
          .filter(({ display }) =>
            display.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
          )
          .map(({ source, display }) => (
            <button className="novel-card" key={source.id} onClick={() => setSelected(source)}>
              <strong>{display.name}</strong>
              <span>続きを読む</span>
            </button>
          ))}
      </div>
      {selected && (
        <FilePreview account={account} node={selected} close={() => setSelected(null)} />
      )}
    </section>
  );
}
