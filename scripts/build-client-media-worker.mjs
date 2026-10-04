import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const webRoot = fileURLToPath(new URL("../packages/web/", import.meta.url));
const entry = fileURLToPath(
  new URL("../packages/web/src/clientMediaServiceWorkerEntry.ts", import.meta.url),
);
const outputPath = "public-assets/client-media-worker.js";

// The public Access-bypass script must be one self-contained file. A module
// import from private-assets would redirect during installation before the
// Service Worker can run its authenticated /me and client checks.
const result = await build({
  configFile: false,
  root: webRoot,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    manifest: false,
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: entry,
      output: {
        format: "es",
        inlineDynamicImports: true,
        entryFileNames: outputPath,
      },
    },
  },
});
assert.ok(!Array.isArray(result), "unexpected multiple Service Worker outputs");
assert.equal(result.output.length, 1, "Service Worker must be self-contained");
const chunk = result.output[0];
assert.equal(chunk?.type, "chunk");
assert.equal(chunk.fileName, outputPath);
assert.deepEqual(chunk.imports, []);
assert.deepEqual(chunk.dynamicImports, []);
console.log("Built one self-contained public client media worker.");
