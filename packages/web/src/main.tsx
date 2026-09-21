import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

function App(): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 text-slate-100">
      <section className="rounded-2xl border border-white/10 bg-white/5 px-10 py-8 shadow-2xl backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">Foundation</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Next Cloud Flare</h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
          The private storage workspace is being initialized.
        </p>
      </section>
    </main>
  );
}

const root = document.querySelector<HTMLElement>("#root");
if (root === null) {
  throw new Error("Application root is missing");
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
