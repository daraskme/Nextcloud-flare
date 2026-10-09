import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";

export function TextReader({ text, storageKey }: { text: string; storageKey: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(18);
  const [progress, setProgress] = useState(0);
  const blocks = useMemo(() => {
    const parts: string[] = [];
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 2400, text.length);
      const line = text.lastIndexOf("\n", end);
      if (line > start + 1200) end = line + 1;
      parts.push(text.slice(start, end));
      start = end;
    }
    return parts;
  }, [text]);
  const virtual = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 1200,
    overscan: 2,
  });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        index: number;
        size: number;
      } | null;
      if (saved && Number.isInteger(saved.index)) {
        setSize([16, 18, 20, 24, 28].includes(saved.size) ? saved.size : 18);
        virtual.scrollToIndex(Math.max(0, Math.min(saved.index, blocks.length - 1)), {
          align: "start",
        });
      }
    } catch {
      /* Reading remains available with storage disabled. */
    }
  }, [storageKey, blocks]);
  useEffect(() => virtual.measure(), [size]);
  return (
    <section className="novel-reader" aria-label="小説リーダー">
      <div className="reader-toolbar">
        <label>
          文字サイズ{" "}
          <select value={size} onChange={(event) => setSize(Number(event.target.value))}>
            {[16, 18, 20, 24, 28].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <span>読書位置 {progress}%</span>
      </div>
      <div
        ref={scroller}
        className="novel-pages"
        tabIndex={0}
        aria-label="本文"
        style={{ fontSize: size }}
        onScroll={() => {
          const index = virtual.range?.startIndex ?? 0;
          const element = scroller.current!;
          setProgress(
            Math.round(
              (100 * element.scrollTop) / Math.max(1, element.scrollHeight - element.clientHeight),
            ),
          );
          try {
            localStorage.setItem(storageKey, JSON.stringify({ index, size }));
          } catch {
            /* Optional local progress. */
          }
        }}
      >
        {!text && <p>このテキストファイルは空です。</p>}
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              className="novel-block"
              style={{
                position: "absolute",
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              {blocks[item.index]}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
