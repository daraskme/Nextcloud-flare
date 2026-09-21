import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

type Entry = "app" | "public-share" | "reader";

const entries: Record<Entry, { html: string; dir: string }> = {
  app: { html: "./index.html", dir: "assets" },
  "public-share": { html: "./public-share.html", dir: "public-assets" },
  reader: { html: "./reader.html", dir: "reader-assets" },
};

function entryFor(mode: string): Entry {
  return mode === "public-share" || mode === "reader" ? mode : "app";
}

// Each shell is built as its own single-entry bundle (`vite build --mode <entry>`) so the
// public share landing and the sandboxed reader never import chunks from the private SPA.
export default defineConfig(({ mode }) => {
  const entry = entryFor(mode);
  const { html, dir } = entries[entry];
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@ncf/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "^/api(?:/|$)": "http://127.0.0.1:8787",
        "^/dav(?:/|$)": "http://127.0.0.1:8787",
        "^/s(?:/|$)": "http://127.0.0.1:8787",
        "^/c(?:/|$)": "http://127.0.0.1:8787",
        "^/public-assets(?:/|$)": "http://127.0.0.1:8787",
        "^/reader(?:/|$)": "http://127.0.0.1:8787",
        "^/reader-assets(?:/|$)": "http://127.0.0.1:8787",
      },
    },
    build: {
      manifest: entry === "app" ? true : `.vite/manifest.${entry}.json`,
      sourcemap: true,
      emptyOutDir: entry === "app",
      copyPublicDir: entry === "app",
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: { [entry]: fileURLToPath(new URL(html, import.meta.url)) },
        output: {
          inlineDynamicImports: true,
          entryFileNames: `${dir}/[name].[hash].js`,
          chunkFileNames: `${dir}/[name].[hash].js`,
          assetFileNames: `${dir}/[name].[hash][extname]`,
        },
      },
    },
  };
});
