import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    modulePreload: { polyfill: false },
    assetsDir: "private-assets",
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        publicShare: resolve(import.meta.dirname, "public-share.html"),
      },
      output: {
        entryFileNames(chunk) {
          return chunk.name === "publicShare"
            ? "public-assets/public-share-[hash].js"
            : "private-assets/[name]-[hash].js";
        },
        chunkFileNames: "private-assets/[name]-[hash].js",
        assetFileNames(asset) {
          return asset.names.some((name) => name.toLowerCase().includes("publicshare"))
            ? "public-assets/[name]-[hash][extname]"
            : "private-assets/[name]-[hash][extname]";
        },
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("@tanstack")) return "navigation";
          if (id.includes("@radix-ui")) return "ui";
        },
      },
    },
  },
});
