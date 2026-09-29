import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { AudioTrack } from "../../../shared/src/audio";
import type { AudioClient } from "./audioClient";

export type CoverLoader = (item: AudioTrack, signal: AbortSignal) => Promise<Blob>;
const Context = createContext<CoverLoader | null>(null);
export function AudioCovers({
  items,
  client,
  children,
}: {
  items: AudioTrack[];
  client: AudioClient;
  children: ReactNode;
}) {
  const [load, setLoad] = useState<CoverLoader | null>(null);
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, client.signal]);
    setLoad(null);
    signal.addEventListener("abort", () => setLoad(null), { once: true });
    if (client.prepareCovers) {
      const ready = items.filter((item) => item.cover === "ready"),
        loaders = new Map<string, CoverLoader>();
      let active = 0;
      const waiting: (() => void)[] = [];
      const prepare = async () => {
        signal.throwIfAborted();
        for (let at = 0; at < ready.length; at += 500) {
          const group = ready.slice(at, at + 500),
            loader = await client.prepareCovers!(group, signal);
          signal.throwIfAborted();
          for (const item of group) loaders.set(item.id, loader);
        }
        if (!ready.length) return;
        setLoad(() => async (item: AudioTrack, request: AbortSignal) => {
          if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
          else active++;
          try {
            const current = AbortSignal.any([signal, request, AbortSignal.timeout(30000)]);
            current.throwIfAborted();
            const loader = loaders.get(item.id);
            if (!loader) throw new Error("cover_unavailable");
            return await loader(item, current);
          } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
          }
        });
      };
      void prepare().catch(() => {});
    }
    return () => stop.abort();
  }, [items, client]);
  return <Context.Provider value={load}>{children}</Context.Provider>;
}

export function AudioCover({ item, load: provided }: { item: AudioTrack; load?: CoverLoader }) {
  const contextual = useContext(Context),
    load = provided ?? contextual,
    host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      rootMargin: "80px",
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(null);
    if (!visible || !load || item.cover !== "ready") return;
    const stop = new AbortController();
    let object: string | undefined;
    void load(item, stop.signal)
      .then((blob) => {
        stop.signal.throwIfAborted();
        object = URL.createObjectURL(blob);
        setUrl(object);
      })
      .catch(() => {});
    return () => {
      stop.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [item, load, visible]);
  return (
    <span ref={host} className="audio-cover" aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(null)} /> : "♫"}
    </span>
  );
}
