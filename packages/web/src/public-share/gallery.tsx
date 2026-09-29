import { useEffect, useMemo, useRef, useState } from "react";
import type { GalleryItem, GalleryPage } from "../../../shared/src/gallery";
import "./gallery.css";

export interface GalleryClient {
  list(recursive: boolean, cursor: string | null, signal: AbortSignal): Promise<GalleryPage>;
  prepare(
    items: GalleryItem[],
    signal: AbortSignal,
  ): Promise<(item: GalleryItem, signal: AbortSignal) => Promise<Blob>>;
  original(item: GalleryItem, signal: AbortSignal): Promise<string>;
  preview(item: GalleryItem, signal: AbortSignal): Promise<Blob | null>;
}
type Loader = (item: GalleryItem, signal: AbortSignal) => Promise<Blob>;
function limited(load: Loader): Loader {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (item, signal) => {
    if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      signal.throwIfAborted();
      return await load(item, signal);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
function Thumbnail({ item, load }: { item: GalleryItem; load: Loader }) {
  const element = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false),
    [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      rootMargin: "80px",
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || item.thumbnail !== "ready") return;
    const controller = new AbortController();
    let object: string | undefined;
    void load(item, controller.signal)
      .then((blob) => {
        controller.signal.throwIfAborted();
        object = URL.createObjectURL(blob);
        setUrl(object);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUrl(null);
      });
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
      setUrl(null);
    };
  }, [visible, item, load]);
  return (
    <span ref={element} className="gallery-thumb">
      {url ? (
        <img src={url} alt="" onError={() => setUrl(null)} />
      ) : (
        <span>
          {item.mime.startsWith("video/")
            ? "▶ 動画"
            : item.thumbnail === "pending"
              ? "準備中"
              : "プレビューなし"}
        </span>
      )}
    </span>
  );
}
function VideoOriginal({ item, url }: { item: GalleryItem; url: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(
    () => document.createElement("video").canPlayType(item.mime) === "",
  );
  useEffect(() => {
    const current = video.current;
    return () => {
      current?.pause();
      current?.removeAttribute("src");
      current?.load();
    };
  }, [failed]);
  return (
    <div className="gallery-video">
      {failed ? (
        <p role="alert">
          この端末では動画を再生できません。原本をダウンロードして対応するプレーヤーで開いてください。
        </p>
      ) : (
        <video
          ref={video}
          src={url}
          controls
          playsInline
          preload="metadata"
          crossOrigin="use-credentials"
          aria-label={item.name}
          onError={() => setFailed(true)}
        />
      )}
      <a href={`${url}?download=1`} target="_blank" rel="noopener noreferrer">
        原本をダウンロード
      </a>
    </div>
  );
}
function Lightbox({
  items,
  index,
  select,
  client,
}: {
  items: GalleryItem[];
  index: number;
  select: (index: number | null) => void;
  client: GalleryClient;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    item = items[index]!,
    video = item.mime.startsWith("video/"),
    [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState(false),
    [original, setOriginal] = useState(false),
    [preview, setPreview] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let object: string | undefined;
    setUrl(null);
    setError(false);
    setPreview(false);
    const open = async () => {
      if (!original && !video) {
        const blob = await client.preview(item, controller.signal).catch(() => null);
        controller.signal.throwIfAborted();
        if (blob) {
          object = URL.createObjectURL(blob);
          setPreview(true);
          return object;
        }
      }
      return client.original(item, controller.signal);
    };
    void open()
      .then((value) => {
        controller.signal.throwIfAborted();
        setUrl(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [item, client, original, refresh, video]);
  return (
    <dialog
      ref={dialog}
      className="gallery-lightbox"
      aria-label={video ? "動画の詳細" : "画像の詳細"}
      onCancel={() => select(null)}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLVideoElement) return;
        if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          select(index - 1);
        }
        if (event.key === "ArrowRight" && index + 1 < items.length) {
          event.preventDefault();
          select(index + 1);
        }
      }}
    >
      <header>
        <h3>{item.name}</h3>
        <button onClick={() => select(null)} aria-label={video ? "動画を閉じる" : "画像を閉じる"}>
          閉じる ×
        </button>
      </header>
      <div className="gallery-original">
        {error ? (
          <p role="alert">原本を表示できません。一覧を更新して開き直してください。</p>
        ) : url ? (
          video ? (
            <VideoOriginal key={`${item.id}:${url}`} item={item} url={url} />
          ) : (
            <img src={url} alt={item.name} onError={() => setError(true)} />
          )
        ) : (
          <p role="status">{video ? "動画を開いています…" : "画像を開いています…"}</p>
        )}
      </div>
      <p>
        {preview ? "プレビュー · " : "原本 · "}
        {item.width} × {item.height}
        {video && item.durationMs != null
          ? ` · ${Math.floor(item.durationMs / 60000)}:${String(Math.floor(item.durationMs / 1000) % 60).padStart(2, "0")}`
          : ""}
        {item.takenAt !== null ? ` · ${new Date(item.takenAt).toLocaleString("ja-JP")}` : ""}
        {item.cameraMake ? ` · ${item.cameraMake}` : ""}
        {item.cameraModel ? ` ${item.cameraModel}` : ""}
      </p>
      {!video && (
        <div className="gallery-detail-mode">
          <button disabled={!preview && original} onClick={() => setOriginal(true)}>
            原本を表示
          </button>
          <button
            onClick={() => {
              setOriginal(false);
              setRefresh((x) => x + 1);
            }}
          >
            軽いプレビューを表示
          </button>
        </div>
      )}
      <footer>
        <button disabled={index === 0} onClick={() => select(index - 1)}>
          {video ? "前の項目" : "前の画像"}
        </button>
        <span>
          {index + 1} / {items.length}
        </span>
        <button disabled={index + 1 === items.length} onClick={() => select(index + 1)}>
          {video ? "次の項目" : "次の画像"}
        </button>
      </footer>
    </dialog>
  );
}
function GalleryItems({
  page,
  client,
  view,
  setView,
}: {
  page: GalleryPage;
  client: GalleryClient;
  view: "grid" | "list";
  setView: (view: "grid" | "list") => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [load, setLoad] = useState<Loader | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoad(null);
    const ready = page.items.filter((item) => item.thumbnail === "ready");
    if (ready.length)
      void client
        .prepare(ready, controller.signal)
        .then((loader) => {
          controller.signal.throwIfAborted();
          setLoad(() =>
            limited((item, signal) =>
              loader(
                item,
                AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]),
              ),
            ),
          );
        })
        .catch(() => {});
    return () => controller.abort();
  }, [page, client]);
  const placeholder = useMemo<Loader>(
    () => async () => {
      throw new Error("thumbnail_unavailable");
    },
    [],
  );
  return (
    <>
      <div className="gallery-layout">
        <span>{page.items.length}件 · 撮影日時順</span>
        <button aria-pressed={view === "grid"} onClick={() => setView("grid")}>
          グリッド表示
        </button>
        <button aria-pressed={view === "list"} onClick={() => setView("list")}>
          リスト表示
        </button>
      </div>
      <ul className={`gallery-items gallery-${view}`} aria-label="画像・動画一覧">
        {page.items.map((item, index) => (
          <li key={`${item.id}:${item.currentBlobId}`}>
            <button
              className="gallery-card"
              aria-label={`${item.name}を表示`}
              onClick={() => setSelected(index)}
            >
              <Thumbnail item={item} load={load ?? placeholder} />
              <span className="gallery-caption">
                <strong>{item.name}</strong>
                <small>
                  {item.width} × {item.height}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!page.items.length && (
        <p className="gallery-empty">
          この範囲に表示できる画像・動画はありません。ファイルを追加した後は更新してください。
        </p>
      )}
      {selected !== null && (
        <Lightbox items={page.items} index={selected} select={setSelected} client={client} />
      )}
    </>
  );
}

/** Pure public/private presentation. All authority and transport are supplied by the caller. */
export function Gallery({ client }: { client: GalleryClient }) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [recursive, setRecursive] = useState(false),
    [cursors, setCursors] = useState<(string | null)[]>([null]),
    [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<GalleryPage | null>(null),
    [error, setError] = useState(false);
  const cursor = cursors.at(-1)!;
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError(false);
    void client
      .list(recursive, cursor, controller.signal)
      .then((value) => {
        controller.signal.throwIfAborted();
        setPage(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [client, recursive, cursor, refresh]);
  return (
    <section className="gallery" aria-label="ギャラリー">
      <div className="gallery-heading">
        <h2>ギャラリー</h2>
        <label>
          <input
            type="checkbox"
            checked={recursive}
            onChange={(event) => {
              setRecursive(event.target.checked);
              setCursors([null]);
            }}
          />
          サブフォルダーも表示
        </label>
        <button
          onClick={() => {
            setCursors([null]);
            setRefresh((x) => x + 1);
          }}
        >
          画像を更新
        </button>
      </div>
      {error ? (
        <p role="alert">
          画像を読み込めませんでした。共有やフォルダーの状態をご確認のうえ、画像を更新してください。
        </p>
      ) : !page ? (
        <p role="status">画像を読み込んでいます…</p>
      ) : (
        <>
          {page.truncated && (
            <p className="gallery-limit" role="status">
              表示範囲の上限に達しました。フォルダーを絞り込んでください。
            </p>
          )}
          <GalleryItems
            key={`${page.treeGeneration}:${recursive}:${cursor}:${refresh}`}
            page={page}
            client={client}
            view={view}
            setView={setView}
          />
          <div className="gallery-pagination">
            <button
              disabled={cursors.length === 1}
              onClick={() => setCursors((x) => x.slice(0, -1))}
            >
              前のページ
            </button>
            <span>{cursors.length}ページ</span>
            <button
              disabled={!page.nextCursor}
              onClick={() => setCursors((x) => [...x, page.nextCursor])}
            >
              次のページ
            </button>
          </div>
        </>
      )}
    </section>
  );
}
