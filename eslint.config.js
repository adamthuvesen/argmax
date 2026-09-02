import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "src-tauri/target/**",
      // Injected page scripts. They are `include_str!` payloads for the Rust
      // browser automation, not part of the renderer's TS program, so the
      // type-checked rules have no tsconfig to resolve them against.
      "src-tauri/src/browser/*.js",
      "src/shared/bindings.d.ts",
      ".claude/**",
      "eslint.config.js",
      "scripts/*.cjs",
      "scripts/*.mjs",
      "vitest.perf.config.ts"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Pinned explicitly so it's not silently dropped if the recommended
      // ruleset spread (line 22) changes upstream. Kept at "warn" because a
      // few intentional split-deps patterns in the renderer hooks would
      // otherwise fail CI.
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
