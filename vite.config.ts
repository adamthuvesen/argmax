import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // The eager-graph budgets are enforced in CI by `npm run check:bundle`
    // (scripts/check-bundle.mjs: 1.60 MiB for the desktop entry, 1.50 MiB for
    // mobile). This warning limit is deliberately looser — it flags a single
    // oversized chunk locally; the script is what holds the real budget.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        mobile: resolve(__dirname, "mobile.html")
      },
      output: {
        // Split a few specific heavyweight vendor packages into named chunks
        // so they cache independently of app code and the main `index-*.js`
        // chunk stays lean (ralph B7). Anything not matched here lives in
        // main or in feature-lazy chunks emitted by B1–B5.
        //
        // Deliberately NO rule for KaTeX / the unified markdown stack, even
        // though KaTeX is the single largest dependency (~0.5 MB). A
        // `vendor-katex` manual chunk acts as a magnet: Rolldown hoists the
        // micromark/mdast/unist/hast utils shared by remark-gfm (eager, chat
        // renders on first paint) and remark-math/rehype-katex (lazy, see
        // MathMarkdown.tsx) into it, and the eager graph then statically
        // imports that chunk — preloading all of KaTeX on cold start
        // (measured 1.56 MiB eager; without the rule it is ~1.05 MiB).
        // Automatic chunking already places KaTeX in a lazy chunk reached
        // only via MathMarkdown/FilePreview/Mermaid. Do not re-add one
        // without re-measuring `npm run check:bundle`.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("lucide-react")) return "vendor-lucide";
            if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("scheduler")) {
              return "vendor-react";
            }
          }
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
