import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
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
    },
  },
  build: {
    manifest: true,
    sourcemap: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        "public-share": fileURLToPath(new URL("./public-share.html", import.meta.url)),
        reader: fileURLToPath(new URL("./reader.html", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "public-share"
            ? "public-assets/public-share.[hash].js"
            : chunk.name === "reader"
              ? "reader-assets/reader.[hash].js"
              : "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
});
