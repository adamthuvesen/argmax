import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import testingLibrary from "eslint-plugin-testing-library";
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
      // Service worker served as-is from public/. Plain JS, no tsconfig.
      "public/sw.js",
      "src/shared/bindings.d.ts",
      ".claude/**",
      ".argmax/worktrees/**",
      "eslint.config.js",
      ".dependency-cruiser.cjs",
      "scripts/*.cjs",
      "scripts/**/*.mjs",
      // Project verification helpers use plain Node, like scripts/.
      ".agents/skills/verify-argmax/*.mjs",
      ".verify/**",
      // Design-concept render scripts, plain Node with no tsconfig behind them.
      "docs/design/**/*.mjs",
      // Mockup pages vite serves straight from the repo; they import the real
      // components but are not part of the renderer's TS program.
      "docs/design/**/*.tsx",
      "vitest.perf.config.ts",
      // Local throwaways. The directory is gitignored, but `eslint .` still
      // walks it and type-aware rules have no tsconfig for those files.
      "scratch/**"
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
      // react-hooks 7's recommended set adds the React Compiler rules (refs,
      // set-state-in-effect, immutability, purity, ...). They flag ~240
      // deliberate patterns across ~70 files today, so adopting them is its
      // own change; until then only the two classic rules run.
      "react-hooks/rules-of-hooks": "error",
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
  },
  {
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    ignores: ["src/renderer/lib/uuid.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message: "The mobile remote bridge serves an insecure origin where crypto.randomUUID is undefined. Use uuidV4() from lib/uuid.js."
        }
      ]
    }
  },
  {
    files: ["src/renderer/components/**/*.ts", "src/renderer/components/**/*.tsx"],
    ignores: ["src/renderer/components/**/*.test.ts", "src/renderer/components/**/*.test.tsx"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message: "The mobile remote bridge serves an insecure origin where crypto.randomUUID is undefined. Use uuidV4() from lib/uuid.js."
        },
        {
          object: "window",
          property: "argmax",
          message: "Components do not call the bridge. Read with useBridgeQuery from data/useBridgeQuery.js, which drops stale replies. Start a write from data/bridgeActions.js."
        }
      ]
    }
  },
  {
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    ignores: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx", "src/renderer/lib/canonicalTimeline.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.property.name='payload'][computed=false][property.name=/^(thinking|traceImported|traceSyntheticSuperseded|item_type|item|thread_id|sender_thread_id|parent_tool_use_id|preTokens|postTokens|from|provider|modelLabel|checkoutMode|sourceProjectName|destinationProjectName|sourceArchiveState|direction|sourceSessionId|destinationSessionId|destinationWorkspaceId|childSessionId|taskLabel|prompt|worktree|state|answer|id|call_id|tool_use_id|providerInvocationId|name|status|raw|traceSyntheticLaunch)$/]",
          message: "Route timeline semantics through decodeTimelineEvent(). Keep raw payload access for lossless debug bodies and large tool input or output only."
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.property.name='payload'][computed=true][property.value=/^(thinking|traceImported|traceSyntheticSuperseded|item_type|item|thread_id|sender_thread_id|parent_tool_use_id|preTokens|postTokens|from|provider|modelLabel|checkoutMode|sourceProjectName|destinationProjectName|sourceArchiveState|direction|sourceSessionId|destinationSessionId|destinationWorkspaceId|childSessionId|taskLabel|prompt|worktree|state|answer|id|call_id|tool_use_id|providerInvocationId|name|status|raw|traceSyntheticLaunch)$/]",
          message: "Route timeline semantics through decodeTimelineEvent(). Keep raw payload access for lossless debug bodies and large tool input or output only."
        },
        {
          selector: "MemberExpression[object.name='payload'][computed=false][property.name=/^(thinking|traceImported|traceSyntheticSuperseded|item_type|item|thread_id|sender_thread_id|parent_tool_use_id|preTokens|postTokens|from|provider|modelLabel|checkoutMode|sourceProjectName|destinationProjectName|sourceArchiveState|direction|sourceSessionId|destinationSessionId|destinationWorkspaceId|childSessionId|taskLabel|prompt|worktree|state|answer|id|call_id|tool_use_id|providerInvocationId|name|status|raw|traceSyntheticLaunch)$/]",
          message: "Route timeline semantics through decodeTimelineEvent(). Keep raw payload access for lossless debug bodies and large tool input or output only."
        },
        {
          selector: "MemberExpression[object.name='payload'][computed=true][property.value=/^(thinking|traceImported|traceSyntheticSuperseded|item_type|item|thread_id|sender_thread_id|parent_tool_use_id|preTokens|postTokens|from|provider|modelLabel|checkoutMode|sourceProjectName|destinationProjectName|sourceArchiveState|direction|sourceSessionId|destinationSessionId|destinationWorkspaceId|childSessionId|taskLabel|prompt|worktree|state|answer|id|call_id|tool_use_id|providerInvocationId|name|status|raw|traceSyntheticLaunch)$/]",
          message: "Route timeline semantics through decodeTimelineEvent(). Keep raw payload access for lossless debug bodies and large tool input or output only."
        },
        {
          selector: "MemberExpression[property.name='modelId'][object.name=/^(session|routine|previousSession|openSession|parentSession|sourceSession)$/]:not(CallExpression[callee.name=/^(resolveModelId|modelLabelFor|contextWindowForModel)$/] > MemberExpression):not(CallExpression[callee.name=/^(resolveModelId|modelLabelFor|contextWindowForModel)$/] > ChainExpression > MemberExpression)",
          message: "A stored model id can be retired. Read it through resolveModelId(provider, id) from src/shared/providerModels.ts."
        }
      ]
    }
  },
  {
    files: ["src/renderer/**/*.test.tsx"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      "testing-library/no-container": "error",
      "testing-library/no-node-access": "error"
    }
  }
);
