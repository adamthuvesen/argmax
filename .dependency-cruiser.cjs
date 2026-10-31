/** Renderer layers. The comment is the message an agent reads on failure. */
const TEST = "\\.test\\.tsx?$";
module.exports = {
  forbidden: [
    {
      name: "shared-imports-renderer",
      severity: "error",
      comment: "src/shared is the bottom layer. Move the code into src/shared, or pass the value in.",
      from: { path: "^src/shared" },
      to: { path: "^src/renderer" }
    },
    {
      name: "lib-imports-ui",
      severity: "error",
      comment: "lib and state hold logic with no UI. Move the UI-dependent part into a hook, or pass a value in.",
      from: { path: "^src/renderer/(lib|state)/", pathNot: TEST },
      to: { path: "^src/renderer/(components|hooks|mobile)/|^src/renderer/App" }
    },
    {
      name: "hook-imports-component",
      severity: "error",
      comment: "A hook returns data and actions. Move the shared piece into lib or state, and let the component import the hook.",
      from: { path: "^src/renderer/hooks/", pathNot: TEST },
      to: { path: "^src/renderer/components/|^src/renderer/App" }
    },
    {
      name: "imports-app-shell",
      severity: "error",
      comment: "Nothing imports App.tsx. Move the shared piece into lib, state, or a hook.",
      from: { path: "^src/renderer/", pathNot: `${TEST}|^src/renderer/(main|index)` },
      to: { path: "^src/renderer/App\\.tsx$" }
    },
    {
      name: "layout-imports-application-commands",
      severity: "error",
      comment: "A layout component takes props. It does not call the bridge or read overlays.",
      from: { path: "^src/renderer/components/SessionMultiGrid\\.tsx$" },
      to: { path: "tauriBridge|state/overlays|snapshot" }
    },
    {
      name: "circular",
      severity: "error",
      comment: "This import closes a cycle. Move the shared piece down into a module both sides import.",
      from: { pathNot: TEST },
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } }
    }
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.d\\.ts$" }
  }
};
