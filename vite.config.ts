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
    // (scripts/check-bundle.mjs: 1.25 MiB for the desktop entry, 1.00 MiB for
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
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("katex")) return "vendor-katex";
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
