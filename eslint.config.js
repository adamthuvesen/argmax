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
      ".argmax/worktrees/**",
      "eslint.config.js",
      "scripts/*.cjs",
      "scripts/**/*.mjs",
      // Design-concept render scripts, plain Node with no tsconfig behind them.
      "docs/design/**/*.mjs",
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
  },
  {
    files: [
      "src/renderer/components/DetailsPopup.tsx",
      "src/renderer/components/SessionConversation.tsx",
      "src/renderer/hooks/useDashboardSession.ts",
      "src/renderer/lib/agentActivity.ts",
      "src/renderer/lib/compaction.ts",
      "src/renderer/lib/debugTrace.ts",
      "src/renderer/lib/foldConversation.ts",
      "src/renderer/lib/lastTurnFiles.ts",
      "src/renderer/lib/multitask.ts",
      "src/renderer/lib/projectMove.ts",
      "src/renderer/lib/providerSwitch.ts",
      "src/renderer/lib/sessionConversationModel.ts",
      "src/renderer/lib/sessionTimelines.ts",
      "src/renderer/lib/sessionTurnView.ts",
      "src/renderer/lib/sideChat.ts",
      "src/renderer/lib/snapshot.ts",
      "src/renderer/lib/turnBoundaries.ts",
      "src/renderer/lib/turnInteractiveCards.ts"
    ],
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
        }
      ]
    }
  }
);
