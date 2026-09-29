import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { SelectedShare } from "../../../../shared/src/shares";
import { type Account, ApiError, api } from "../../lib/api";
import { Bookshelf } from "../../public-share/bookshelf";

export function PrivateLibrary({
  account,
  rootId,
  share,
}: {
  account: Account;
  rootId: string;
  share?: SelectedShare & { spaceId: string };
}) {
  const navigate = useNavigate(),
    cache = useQueryClient();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const client = useMemo(
    () => api.bookshelfClient(account, rootId, share),
    [
      account.id,
      account.epoch,
      account.contentOrigin,
      rootId,
      share?.id,
      share?.version,
      share?.spaceId,
    ],
  );
  const queryKey = ["library-roots", account.id, account.epoch];
  const roots = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.libraryRoots(signal),
    enabled: !share,
    retry: false,
  });
  const registered = roots.data?.items.some((item) => item.nodeId === rootId);
  const update = async (nodeId: string, add: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      await api.libraryRoot(nodeId, add);
      await cache.invalidateQueries({ queryKey });
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 409
          ? "登録できるフォルダーの上限です。不要な登録を解除してください。"
          : "登録を変更できません。登録一覧を更新して確認してください。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!share && (
        <section className="library-roots" aria-label="登録した本棚">
          <h2>登録したフォルダー</h2>
          {roots.isPending ? (
            <p role="status">登録を読み込んでいます…</p>
          ) : roots.error ? (
            <button type="button" onClick={() => void roots.refetch()}>
              登録一覧を再読み込み
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void update(rootId, !registered)}
              >
                {registered ? "このフォルダーの登録を解除" : "このフォルダーを本棚に登録"}
              </button>
              {roots.data?.items.map((item) => (
                <span className="library-root" key={item.nodeId}>
                  {item.name === null ? (
                    <span>利用できないフォルダー</span>
                  ) : (
                    <Link to="/library/$folderId" params={{ folderId: item.nodeId }}>
                      {item.name}
                    </Link>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${item.name ?? "利用できないフォルダー"}の登録を解除`}
                    onClick={() => void update(item.nodeId, false)}
                  >
                    解除
                  </button>
                </span>
              ))}
            </>
          )}
          {message && <p role="alert">{message}</p>}
        </section>
      )}
      <Bookshelf
        key={`${account.id}:${account.epoch}:${rootId}:${share?.id}:${share?.version}`}
        client={client}
        folder={({ id }) =>
          void navigate(
            share
              ? {
                  to: "/shared/$shareId/$nodeId",
                  params: { shareId: share.id, nodeId: id },
                  search: { view: "library" },
                }
              : { to: "/library/$folderId", params: { folderId: id } },
          )
        }
      />
    </>
  );
}
