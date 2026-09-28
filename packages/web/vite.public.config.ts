import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assertPublicModule, assertPublicSource } from "../../scripts/public-asset-policy.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  plugins: [
    react(),
    {
      name: "public-source-boundary",
      enforce: "pre",
      transform(source, id) {
        if (id.replaceAll("\\", "/").includes("/src/public-share/")) assertPublicSource(source);
      },
      generateBundle(_options, bundle) {
        const modules = new Set<string>();
        for (const chunk of Object.values(bundle))
          if (chunk.type === "chunk") {
            for (const id of Object.keys(chunk.modules)) {
              assertPublicModule(id, root);
              if (id.replaceAll("\\", "/").includes("/src/public-share/"))
                assertPublicSource(this.getModuleInfo(id)?.code ?? "");
              modules.add(id.replace(root, ""));
            }
          }
        this.emitFile({
          type: "asset",
          fileName: ".vite/public-modules.json",
          source: JSON.stringify([...modules].sort()),
        });
      },
    },
  ],
  publicDir: false,
  build: {
    emptyOutDir: false,
    manifest: ".vite/public-manifest.json",
    sourcemap: false,
    assetsDir: "public-assets",
    rollupOptions: {
      input: "public.html",
      output: {
        inlineDynamicImports: true,
        entryFileNames: "public-assets/public-share.[hash].js",
        assetFileNames: "public-assets/public-share.[hash].[ext]",
      },
    },
  },
});
