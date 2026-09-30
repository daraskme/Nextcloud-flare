import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, Expand, Image, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { type Account, api, errorMessage, formatBytes, type GalleryItem } from "../../lib/api";

export function PrivateGallery({ account }: { account: Account }) {
  const query = useInfiniteQuery({
    queryKey: ["gallery", account.id, account.epoch, account.rootNodeId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.gallery(account.rootNodeId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    maxPages: 1,
  });
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const ready = useMemo(() => items.filter((item) => item.thumbnail === "ready"), [items]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [thumbError, setThumbError] = useState("");
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [opening, setOpening] = useState(false);
  const [thumbSession, setThumbSession] = useState(0);

  useEffect(() => {
    if (!ready.length || selected) return;
    const controller = new AbortController();
    setThumbError("");
    void api
      .prepareContent(account, ready, "thumb", controller.signal)
      .then((url) => {
        setThumbUrls(Object.fromEntries(ready.map((item) => [item.id, url(item)])));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setThumbError(errorMessage(error));
      });
    return () => controller.abort();
  }, [account, ready, selected, thumbSession]);

  const open = async (item: GalleryItem) => {
    setSelected(item);
    setOriginalUrl("");
    setOpening(true);
    try {
      const url = await api.prepareContent(account, [item], "content");
      setOriginalUrl(url(item));
    } catch (error) {
      setThumbError(errorMessage(error));
      setSelected(null);
    } finally {
      setOpening(false);
    }
  };
  const close = () => {
    setSelected(null);
    setOriginalUrl("");
    setThumbSession((value) => value + 1);
  };

  if (query.isPending)
    return (
      <div className="empty-state">
        <LoaderCircle size={30} className="spin" />
        <p>写真を読み込んでいます</p>
      </div>
    );
  if (query.error)
    return (
      <div className="empty-state">
        <Image size={42} strokeWidth={1.3} />
        <h2>ギャラリーを開けません</h2>
        <p>{errorMessage(query.error)}</p>
        <Button onClick={() => void query.refetch()}>
          <RefreshCw size={16} />
          読み直す
        </Button>
      </div>
    );
  if (!items.length)
    return (
      <div className="empty-state">
        <Image size={48} strokeWidth={1.3} />
        <h2>表示できる写真がありません</h2>
        <p>画像をアップロードすると、準備ができた写真がここに表示されます。</p>
      </div>
    );

  return (
    <>
      <div className="media-toolbar">
        <span>
          <strong>{items.length}</strong> 枚{query.hasNextPage && "以上"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ギャラリーを更新"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} className={query.isFetching ? "spin" : ""} />
        </Button>
      </div>
      {thumbError && (
        <div className="notice" role="alert">
          <span>{thumbError}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="通知を閉じる"
            onClick={() => setThumbError("")}
          >
            <X size={16} />
          </Button>
        </div>
      )}
      <div className="gallery-grid">
        {items.map((item) => (
          <button className="gallery-card" key={item.id} onClick={() => void open(item)}>
            <span className="gallery-image">
              {item.thumbnail === "ready" && thumbUrls[item.id] ? (
                <img src={thumbUrls[item.id]} alt="" loading="lazy" />
              ) : (
                <span className={`gallery-placeholder gallery-${item.thumbnail}`}>
                  <Image size={32} strokeWidth={1.3} />
                  {item.thumbnail === "failed" ? "サムネイルを作成できません" : "準備中"}
                </span>
              )}
              <span className="gallery-expand">
                <Expand size={15} />
              </span>
            </span>
            <span className="gallery-caption">
              <strong title={item.name}>{item.name}</strong>
              <small>
                {item.width} × {item.height} · {formatBytes(item.size)}
              </small>
            </span>
          </button>
        ))}
      </div>
      {query.hasNextPage && (
        <div className="list-footer">
          <span>新しい写真から表示しています</span>
          <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            さらに読み込む
            <ArrowRight size={15} />
          </Button>
        </div>
      )}
      {selected && (
        <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={selected.name}>
          <div className="media-lightbox-bar">
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.width} × {selected.height}
              </span>
            </div>
            <Button variant="ghost" size="icon" aria-label="写真を閉じる" onClick={close}>
              <X size={22} />
            </Button>
          </div>
          <div className="media-lightbox-content">
            {opening ? (
              <LoaderCircle size={36} className="spin" />
            ) : (
              originalUrl && <img src={originalUrl} alt={selected.name} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
