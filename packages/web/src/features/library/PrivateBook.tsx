import { useMemo, useState } from "react";
import type { SelectedShare } from "../../../../shared/src/shares";
import { type Account, api, type FileNode } from "../../lib/api";
import { BookReader } from "../../public-share/book";

export function PrivateBook({
  account,
  node,
  share,
  close,
}: {
  account: Account;
  node: FileNode;
  share?: SelectedShare & { spaceId: string };
  close: () => void;
}) {
  const client = useMemo(
    () => api.bookClient(account, node, share),
    [
      account.id,
      account.epoch,
      account.contentOrigin,
      node.id,
      node.currentBlobId,
      share?.id,
      share?.version,
      share?.spaceId,
    ],
  );
  const [message, setMessage] = useState("");
  const original = () => {
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setMessage("原本を開くには、このサイトのポップアップを許可してください。");
      return;
    }
    target.opener = null;
    void api
      .openFile(
        account,
        node,
        target,
        share
          ? { spaceId: share.spaceId, share: { id: share.id, version: share.version } }
          : undefined,
      )
      .catch(() => setMessage("原本を開けません。ファイル一覧を更新してください。"));
  };
  return (
    <BookReader
      name={node.name}
      client={client}
      close={close}
      original={original}
      originalMessage={message}
    />
  );
}
