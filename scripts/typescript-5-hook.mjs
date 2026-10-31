// dependency-cruiser supports TypeScript below 7 only. Send its `typescript`
// imports (ESM and CJS) to the `typescript-5` alias while the project itself
// uses TypeScript 7. Preload with: node --import ./scripts/typescript-5-hook.mjs
import { registerHooks } from "node:module";

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(specifier.replace(/^typescript(?=$|\/)/, "typescript-5"), context),
});
