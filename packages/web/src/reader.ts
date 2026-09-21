export {};

interface ReaderLoadMessage {
  type: "ncf-reader-load";
  title: string;
  xhtml: string;
  cfi?: string;
}

const root = document.querySelector<HTMLElement>("#reader-shell");
if (root === null) throw new Error("Reader root is missing");

const layout = document.createElement("div");
layout.className = "reader-layout";
const toolbar = document.createElement("header");
toolbar.className = "reader-toolbar";
const title = document.createElement("strong");
title.className = "reader-title";
title.textContent = "Next Cloud リーダー";
const smaller = document.createElement("button");
smaller.type = "button";
smaller.textContent = "文字を小さく";
const larger = document.createElement("button");
larger.type = "button";
larger.textContent = "文字を大きく";
const theme = document.createElement("button");
theme.type = "button";
theme.textContent = "テーマ切替";
const frame = document.createElement("iframe");
frame.className = "reader-document";
frame.setAttribute("sandbox", "");
frame.title = "EPUB 本文";
toolbar.append(title, smaller, larger, theme);
layout.append(toolbar, frame);
root.append(layout);

let fontSize = 100;
let dark = false;
let currentXhtml = "";

function renderDocument(): void {
  frame.style.height = `${Math.max(600, window.innerHeight - toolbar.offsetHeight)}px`;
  if (currentXhtml === "") return;
  const colors = dark
    ? "body{background:#080b11;color:#f8fafc}"
    : "body{background:#fff;color:#0f172a}";
  const style = `<style>:root{font-size:${fontSize}%}${colors}body{line-height:1.75;max-width:52rem;margin:0 auto;padding:2rem}</style>`;
  frame.srcdoc = currentXhtml.replace("</head>", `${style}</head>`);
}

smaller.addEventListener("click", () => {
  fontSize = Math.max(75, fontSize - 10);
  renderDocument();
});
larger.addEventListener("click", () => {
  fontSize = Math.min(180, fontSize + 10);
  renderDocument();
});
theme.addEventListener("click", () => {
  dark = !dark;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  renderDocument();
});
window.addEventListener("resize", renderDocument);
const parentOrigin = new URL(window.location.href).searchParams.get("parentOrigin");
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    parentOrigin === null ||
    event.source !== window.parent ||
    event.origin !== parentOrigin ||
    typeof event.data !== "object" ||
    event.data === null
  ) {
    return;
  }
  const message = event.data as Partial<ReaderLoadMessage>;
  if (
    message.type !== "ncf-reader-load" ||
    typeof message.title !== "string" ||
    typeof message.xhtml !== "string" ||
    message.xhtml.length > 2 * 1024 * 1024
  ) {
    return;
  }
  title.textContent = message.title;
  currentXhtml = message.xhtml;
  renderDocument();
});
