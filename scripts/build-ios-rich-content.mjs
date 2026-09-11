import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFile } from "node:fs/promises";
import { build } from "vite";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repository, "ios/Argmax/RichContent");
const outDir = resolve(repository, "ios/Argmax/Resources/RichContent");

await build({
  root,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // WKWebView loads this bundle from file://, where module imports fail.
    // Keep Mermaid's lazy imports inside one classic script.
    lib: {
      entry: resolve(root, "main.ts"),
      name: "ArgmaxRichContent",
      formats: ["iife"],
      fileName: "rich-content",
      cssFileName: "rich-content"
    }
  }
});

await copyFile(resolve(root, "index.html"), resolve(outDir, "index.html"));
